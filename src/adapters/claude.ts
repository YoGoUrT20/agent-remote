import { randomUUID } from "node:crypto";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  query,
  listSessions,
  type Options as ClaudeQueryOptions,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  BaseAdapter,
  EventType,
  type AdapterEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  makeEvent,
} from "./base.js";
import type { Settings } from "../config.js";

/**
 * Resolve the Claude Code native binary. The SDK requires the native binary
 * (not the npm wrapper). Resolution order:
 *  1. Explicit hint from CLAUDE_CODE_BINARY_PATH
 *  2. Windows: %APPDATA%/Claude/claude-code/<latest>/claude.exe (desktop app)
 *  3. macOS: ~/.claude/local/claude (desktop app)
 *  4. Fallback: "claude" (hope PATH has it)
 */
function resolveNativeClaudeBinary(hint: string): string {
  if (hint) {
    console.error(`[claude-adapter] using explicit binary path: ${hint}`);
    return hint;
  }

  // Windows: desktop app installs under %APPDATA%/Claude/claude-code/<version>/
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      const ccDir = join(appData, "Claude", "claude-code");
      try {
        const dirs = readdirSync(ccDir).sort();
        for (let i = dirs.length - 1; i >= 0; i--) {
          const candidate = join(ccDir, dirs[i], "claude.exe");
          if (existsSync(candidate)) {
            console.error(`[claude-adapter] resolved native binary: ${candidate}`);
            return candidate;
          }
        }
      } catch {}
    }
  }

  // macOS: desktop app
  if (process.platform === "darwin") {
    const home = process.env.HOME;
    if (home) {
      const candidate = join(home, ".claude", "local", "claude");
      if (existsSync(candidate)) {
        console.error(`[claude-adapter] resolved native binary: ${candidate}`);
        return candidate;
      }
    }
  }

  console.error(`[claude-adapter] no native binary found, falling back to "claude"`);
  return "claude";
}

const MAX_QUEUE = 65536;

const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const;

/* ── Async queue (unbounded async-iterable prompt queue) ── */

interface PromptQueue {
  offer(msg: SDKUserMessage): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage>;
}

function createPromptQueue(): PromptQueue {
  const buffer: SDKUserMessage[] = [];
  const waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  let closed = false;

  return {
    offer(msg: SDKUserMessage) {
      if (closed) return;
      if (waiters.length) {
        waiters.shift()!({ value: msg, done: false });
      } else {
        buffer.push(msg);
      }
    },
    close() {
      closed = true;
      while (waiters.length) {
        waiters.shift()!({ value: undefined as never, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (buffer.length) {
            return Promise.resolve({ value: buffer.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

/* ── Session context ── */

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  interrupt?: () => void;
  close?: () => void;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  promptQueue: PromptQueue;
  queryRuntime: ClaudeQueryRuntime;
  streamPromise: Promise<void>;
  stopped: boolean;
  currentTurnId: string | null;
  threadTitle: string | null;
  inputTokens: number;
  outputTokens: number;
}

/* ── Adapter ── */

export class ClaudeAgentSdkAdapter extends BaseAdapter {
  readonly provider = "claude";

  private _apiKey: string;
  private _model: string;
  private _binaryPath: string;
  private _effort: string;
  private _thinking: boolean;
  private _fastMode: boolean;
  private _defaultCwd: string;
  private _sessions = new Map<string, ClaudeSessionContext>();
  private _runtimeEventQueue: Array<AdapterEvent> = [];
  private _runtimeEventWaiters: Array<(ev: AdapterEvent | null) => void> = [];

  constructor(settings: Settings) {
    super();
    this._apiKey = settings.anthropicApiKey ?? "";
    this._model = settings.claudeModel;
    this._binaryPath = (settings.claudeCodeBinaryPath ?? "").trim();
    this._effort = (settings.claudeEffort ?? "").trim();
    this._thinking = settings.claudeThinking;
    this._fastMode = settings.claudeFastMode;
    const cw = (settings.claudeWorkspaceCwd ?? "").trim();
    this._defaultCwd = cw || process.cwd();
  }

  override async startSession(input: {
    threadId: string;
    cwd?: string;
    model?: string;
    resumeCursor?: unknown;
  }): Promise<ProviderSession> {
    const cwd = input.cwd || this._defaultCwd;
    const model = input.model || this._model;

    console.error(`[claude-adapter] startSession threadId=${input.threadId} cwd=${cwd}`);

    if (this._sessions.has(input.threadId)) {
      throw new Error(`session already started for thread ${input.threadId}`);
    }

    const promptQueue = createPromptQueue();

    const settings: Record<string, unknown> = {};
    if (this._thinking) settings.alwaysThinkingEnabled = true;
    if (this._fastMode) settings.fastMode = true;

    const queryOptions: ClaudeQueryOptions = {
      cwd,
      pathToClaudeCodeExecutable: resolveNativeClaudeBinary(this._binaryPath),
      settingSources: [...CLAUDE_SETTING_SOURCES],
      includePartialMessages: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: this._apiKey.trim().length > 0
        ? { ...process.env, ANTHROPIC_API_KEY: this._apiKey }
        : { ...process.env },
      additionalDirectories: [cwd],
      canUseTool: async (toolName, toolInput) => {
        if (toolName === "AskUserQuestion") {
          return {
            behavior: "deny" as const,
            message: "This bridge does not support AskUserQuestion.",
          };
        }
        if (toolName === "ExitPlanMode") {
          return {
            behavior: "deny" as const,
            message: "Stop here and wait for user follow-up outside plan mode.",
          };
        }
        return { behavior: "allow" as const, updatedInput: toolInput };
      },
    };

    if (model) queryOptions.model = model;
    if (this._effort) (queryOptions as Record<string, unknown>).effort = this._effort;
    if (Object.keys(settings).length > 0) queryOptions.settings = settings;
    if (input.resumeCursor && typeof input.resumeCursor === "string") {
      queryOptions.resume = input.resumeCursor;
    }

    let queryRuntime: ClaudeQueryRuntime;
    try {
      queryRuntime = query({ prompt: promptQueue, options: queryOptions }) as ClaudeQueryRuntime;
      console.error(`[claude-adapter] query() created for thread ${input.threadId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to start Claude runtime session: ${msg}`);
    }

    const now = new Date().toISOString();
    const session: ProviderSession = {
      threadId: input.threadId,
      status: "ready",
      cwd,
      model,
      resumeCursor: input.resumeCursor,
      createdAt: now,
      updatedAt: now,
    };

    const ctx: ClaudeSessionContext = {
      session,
      promptQueue,
      queryRuntime,
      streamPromise: Promise.resolve(),
      stopped: false,
      currentTurnId: null,
      threadTitle: null,
      inputTokens: 0,
      outputTokens: 0,
    };

    /* Consume the SDK stream in background */
    ctx.streamPromise = this._consumeStream(input.threadId, ctx);

    this._sessions.set(input.threadId, ctx);
    console.error(`[claude-adapter] session registered for thread ${input.threadId}`);

    return session;
  }

  /* ── Stream consumer (replaces bridge.mjs for-await + _pumpStdout) ── */

  private async _consumeStream(
    threadId: string,
    ctx: ClaudeSessionContext,
  ): Promise<void> {
    try {
      for await (const message of ctx.queryRuntime) {
        if (ctx.stopped) break;
        this._handleSdkMessage(threadId, ctx, message);
      }
    } catch (e) {
      if (ctx.stopped) return;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[claude-adapter] stream error for ${threadId}:`, msg);
      this._offerRuntimeEvent(makeEvent(EventType.ERROR, msg));
      this._offerRuntimeEvent(makeEvent(EventType.DONE));
    }

    /* Stream ended — if a turn was active, close it */
    if (ctx.currentTurnId) {
      ctx.currentTurnId = null;
      this._offerRuntimeEvent(makeEvent(EventType.DONE));
    }

    /* Fetch thread title from session */
    if (!ctx.stopped) {
      try {
        const sessions = await listSessions({ dir: ctx.session.cwd ?? ".", limit: 1 });
        if (sessions.length > 0 && sessions[0].summary) {
          ctx.threadTitle = sessions[0].summary;
        }
      } catch {}
    }
  }

  /* ── SDK message handler ── */

  private _handleSdkMessage(
    _threadId: string,
    ctx: ClaudeSessionContext,
    message: SDKMessage,
  ): void {
    const msgAny = message as Record<string, unknown>;

    switch (message.type) {
      case "stream_event": {
        const ev = msgAny.event as Record<string, unknown> | undefined;
        if (!ev) return;
        if (ev.type === "content_block_delta") {
          const delta = ev.delta as Record<string, unknown> | undefined;
          if (!delta) return;
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            this._offerRuntimeEvent(makeEvent(EventType.TEXT_DELTA, delta.text));
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
            this._offerRuntimeEvent(
              makeEvent(EventType.TEXT_DELTA, delta.thinking, { streamKind: "reasoning_text" }),
            );
          }
        }
        /* Capture token usage from message_delta events */
        if (ev.type === "message_delta") {
          const usage = ev.usage as Record<string, unknown> | undefined;
          if (usage) {
            const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
            if (outputTokens > 0) ctx.outputTokens = outputTokens;
          }
        }
        /* Capture token usage from message_start events */
        if (ev.type === "message_start") {
          const msg = ev.message as Record<string, unknown> | undefined;
          const usage = msg?.usage as Record<string, unknown> | undefined;
          if (usage) {
            const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
            if (inputTokens > 0) ctx.inputTokens += inputTokens;
          }
        }
        return;
      }

      case "result": {
        const resultMsg = message as SDKMessage & { session_id?: string; usage?: Record<string, unknown> };
        if (resultMsg.session_id) {
          ctx.session.resumeCursor = resultMsg.session_id;
        }
        /* Extract usage from result if present */
        const resultUsage = msgAny.usage as Record<string, unknown> | undefined;
        if (resultUsage) {
          if (typeof resultUsage.input_tokens === "number") ctx.inputTokens = resultUsage.input_tokens;
          if (typeof resultUsage.output_tokens === "number") ctx.outputTokens = resultUsage.output_tokens;
        }

        /* Check if the result is an error (SDKResultError) */
        const isError = msgAny.is_error === true;
        const subtype = typeof msgAny.subtype === "string" ? msgAny.subtype : "";
        const errors = Array.isArray(msgAny.errors) ? (msgAny.errors as string[]) : [];

        if (subtype !== "success" && (isError || subtype.startsWith("error_") || errors.length > 0)) {
          let errorMsg = "";
          if (errors.length > 0) {
            errorMsg = errors.join("\n");
          } else if (subtype === "error_during_execution") {
            errorMsg = "An error occurred during execution.";
          } else if (subtype === "error_max_turns") {
            errorMsg = "Maximum number of turns reached.";
          } else if (subtype === "error_max_budget_usd") {
            errorMsg = "Maximum budget limit reached.";
          } else {
            errorMsg = `Claude Code returned an error (${subtype || "unknown"}).`;
          }
          console.error(`[claude-adapter] result error: subtype=${subtype} errors=${JSON.stringify(errors)}`);
          if (!(ctx as any).turnErrorEmitted) {
            this._offerRuntimeEvent(makeEvent(EventType.ERROR, errorMsg));
            (ctx as any).turnErrorEmitted = true;
          }
        }

        const doneMeta: Record<string, unknown> = {};
        if (ctx.inputTokens > 0) doneMeta.inputTokens = ctx.inputTokens;
        if (ctx.outputTokens > 0) doneMeta.outputTokens = ctx.outputTokens;

        ctx.currentTurnId = null;
        (ctx as any).turnErrorEmitted = false;
        ctx.session.status = "ready";
        ctx.session.activeTurnId = undefined;
        ctx.session.updatedAt = new Date().toISOString();
        this._offerRuntimeEvent(makeEvent(EventType.DONE, "", Object.keys(doneMeta).length > 0 ? doneMeta : null));

        /* Reset counters for next turn */
        ctx.inputTokens = 0;
        ctx.outputTokens = 0;
        return;
      }

      /* Rate limit events — surface rejections as errors */
      case "rate_limit_event": {
        const info = msgAny.rate_limit_info as Record<string, unknown> | undefined;
        if (info && info.status === "rejected") {
          let errorMsg = "⚠️ **Rate limit reached.**";
          const rateLimitType = info.rateLimitType as string | undefined;
          const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt : undefined;
          if (rateLimitType) {
            const typeLabel = rateLimitType.replace(/_/g, " ");
            errorMsg += ` Limit type: ${typeLabel}.`;
          }
          if (resetsAt) {
            errorMsg += ` Resets at <t:${resetsAt}:t> (<t:${resetsAt}:R>).`;
          }
          console.error(`[claude-adapter] rate limit rejected: ${JSON.stringify(info)}`);
          if (!(ctx as any).turnErrorEmitted) {
            this._offerRuntimeEvent(makeEvent(EventType.ERROR, errorMsg));
            (ctx as any).turnErrorEmitted = true;
          }
        } else if (info && info.status === "allowed_warning") {
          const utilization = typeof info.utilization === "number" ? info.utilization : undefined;
          if (utilization != null) {
            console.error(`[claude-adapter] rate limit warning: ${Math.round(utilization * 100)}% utilization`);
          }
        }
        return;
      }

      /* System messages — surface API retries */
      case "system": {
        const subtype = typeof msgAny.subtype === "string" ? msgAny.subtype : "";
        if (subtype === "api_retry") {
          const attempt = typeof msgAny.attempt === "number" ? msgAny.attempt : 0;
          const maxRetries = typeof msgAny.max_retries === "number" ? msgAny.max_retries : 0;
          const errorType = typeof msgAny.error === "string" ? msgAny.error : "unknown";
          const errorStatus = typeof msgAny.error_status === "number" ? msgAny.error_status : null;
          console.error(`[claude-adapter] API retry ${attempt}/${maxRetries} error=${errorType} status=${errorStatus}`);

          /* Surface user-facing errors for rate limits & billing */
          if (errorType === "rate_limit") {
            this._offerRuntimeEvent(
              makeEvent(EventType.TEXT_DELTA, `\n\n⏳ *Rate limited — retrying (${attempt}/${maxRetries})...*\n\n`, { streamKind: "status" }),
            );
          } else if (errorType === "billing_error") {
            this._offerRuntimeEvent(
              makeEvent(EventType.TEXT_DELTA, `\n\n⚠️ *Billing error — retrying (${attempt}/${maxRetries})...*\n\n`, { streamKind: "status" }),
            );
          } else if (errorType === "authentication_failed") {
            this._offerRuntimeEvent(
              makeEvent(EventType.TEXT_DELTA, `\n\n🔑 *Authentication failed — retrying (${attempt}/${maxRetries})...*\n\n`, { streamKind: "status" }),
            );
          } else if (errorType === "server_error") {
            this._offerRuntimeEvent(
              makeEvent(EventType.TEXT_DELTA, `\n\n🔄 *Server error — retrying (${attempt}/${maxRetries})...*\n\n`, { streamKind: "status" }),
            );
          }
        }
        return;
      }

      /* Assistant messages — check for error field (rate_limit, billing, etc.) */
      case "assistant": {
        const errField = typeof msgAny.error === "string" ? msgAny.error : undefined;
        if (errField) {
          const errorLabels: Record<string, string> = {
            rate_limit: "Rate limit reached",
            billing_error: "Billing error — check your Anthropic account",
            authentication_failed: "Authentication failed — check your API key",
            server_error: "Anthropic server error",
            invalid_request: "Invalid request",
            max_output_tokens: "Maximum output tokens reached",
          };
          const label = errorLabels[errField] ?? `Error: ${errField}`;
          console.error(`[claude-adapter] assistant message error: ${errField}`);
          if (!(ctx as any).turnErrorEmitted) {
            this._offerRuntimeEvent(makeEvent(EventType.ERROR, label));
            (ctx as any).turnErrorEmitted = true;
          }
        }
        return;
      }

      default:
        return;
    }
  }

  /* ── Event queue (unchanged) ── */

  private _offerRuntimeEvent(ev: AdapterEvent): void {
    if (this._runtimeEventWaiters.length) {
      this._runtimeEventWaiters.shift()?.(ev);
    } else {
      this._runtimeEventQueue.push(ev);
      if (this._runtimeEventQueue.length > MAX_QUEUE) {
        this._runtimeEventQueue.shift();
      }
    }
  }

  /* ── sendTurn: offer message to prompt queue ── */

  override async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    console.error(`[claude-adapter] sendTurn threadId=${input.threadId} input=${input.input?.slice(0, 50)}...`);

    const ctx = this._sessions.get(input.threadId);
    if (!ctx) {
      throw new Error(`session not found for thread ${input.threadId}`);
    }

    const turnId = randomUUID();
    ctx.currentTurnId = turnId;
    ctx.session.status = "running";
    ctx.session.activeTurnId = turnId;
    ctx.session.updatedAt = new Date().toISOString();

    const text = input.input ?? "";

    /* Build user message */
    const userMessage: SDKUserMessage = {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    };

    console.error(`[claude-adapter] offering user message to prompt queue`);
    ctx.promptQueue.offer(userMessage);

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: ctx.session.resumeCursor,
    };
  }

  override async interruptTurn(threadId: string, _turnId?: string): Promise<void> {
    const ctx = this._sessions.get(threadId);
    if (!ctx) return;
    ctx.currentTurnId = null;
    ctx.session.status = "ready";
    ctx.session.activeTurnId = undefined;
    ctx.session.updatedAt = new Date().toISOString();
  }

  override async stopSession(threadId: string): Promise<void> {
    const ctx = this._sessions.get(threadId);
    if (!ctx) return;
    this._sessions.delete(threadId);
    ctx.stopped = true;
    ctx.promptQueue.close();
    try {
      if (typeof ctx.queryRuntime.close === "function") ctx.queryRuntime.close();
    } catch {}
    await ctx.streamPromise.catch(() => {});
  }

  override async *streamEvents(): AsyncGenerator<AdapterEvent, void, undefined> {
    for (;;) {
      if (this._runtimeEventQueue.length) {
        yield this._runtimeEventQueue.shift()!;
      } else {
        const ev = await new Promise<AdapterEvent | null>((resolve) =>
          this._runtimeEventWaiters.push(resolve),
        );
        if (ev == null) break;
        yield ev;
      }
    }
  }

  override async listSessions(): Promise<ReadonlyArray<ProviderSession>> {
    return Array.from(this._sessions.values()).map((ctx) => ctx.session);
  }

  override async hasSession(threadId: string): Promise<boolean> {
    return this._sessions.has(threadId);
  }

  getThreadTitle(threadId: string): string | null {
    const ctx = this._sessions.get(threadId);
    return ctx?.threadTitle ?? null;
  }

  override getSessionModel(threadId: string): string | null {
    const ctx = this._sessions.get(threadId);
    return ctx?.session.model ?? null;
  }

  getSessionId(threadId: string): string | null {
    const ctx = this._sessions.get(threadId);
    const cursor = ctx?.session.resumeCursor;
    return typeof cursor === "string" ? cursor : null;
  }

  override async cancel(): Promise<void> {
    const sessionIds = Array.from(this._sessions.keys());
    for (const threadId of sessionIds) {
      await this.stopSession(threadId);
    }
  }
}
