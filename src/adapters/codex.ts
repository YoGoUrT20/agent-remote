import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
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

/* ── JSON-RPC types ── */

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/* ── ANSI escape stripper ── */

const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/* ── Session context ── */

interface CodexSessionContext {
  session: ProviderSession;
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingRequest>;
  nextRequestId: number;
  currentTurnId: string | null;
  threadTitle: string | null;
  providerThreadId: string | null;
  stopped: boolean;
}

/* ── Adapter ── */

const MAX_QUEUE = 65536;
const DEFAULT_RPC_TIMEOUT_MS = 20_000;

export class CodexCliAdapter extends BaseAdapter {
  readonly provider = "codex";

  private _model: string;
  private _binaryPath: string;
  private _homePath: string;
  private _defaultCwd: string;
  private _sessions = new Map<string, CodexSessionContext>();
  private _runtimeEventQueue: Array<AdapterEvent> = [];
  private _runtimeEventWaiters: Array<(ev: AdapterEvent | null) => void> = [];

  constructor(settings: Settings) {
    super();
    this._model = settings.codexModel;
    this._binaryPath = (settings.codexBinaryPath ?? "").trim() || "codex";
    this._homePath = (settings.codexHomePath ?? "").trim();
    const cw = (settings.claudeWorkspaceCwd ?? "").trim();
    this._defaultCwd = cw || process.cwd();
  }

  /* ── Start session: spawn codex app-server, handshake, open thread ── */

  override async startSession(input: {
    threadId: string;
    cwd?: string;
    model?: string;
    resumeCursor?: unknown;
  }): Promise<ProviderSession> {
    const cwd = input.cwd || this._defaultCwd;
    const model = input.model || this._model;

    console.error(`[codex-adapter] startSession threadId=${input.threadId} cwd=${cwd}`);

    if (this._sessions.has(input.threadId)) {
      throw new Error(`session already started for thread ${input.threadId}`);
    }

    /* Spawn codex app-server */
    const env: Record<string, string | undefined> = { ...process.env };
    if (this._homePath) env.CODEX_HOME = this._homePath;

    const child = spawn(this._binaryPath, ["app-server"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    const now = new Date().toISOString();
    const session: ProviderSession = {
      threadId: input.threadId,
      status: "connecting",
      cwd,
      model,
      resumeCursor: input.resumeCursor,
      createdAt: now,
      updatedAt: now,
    };

    const ctx: CodexSessionContext = {
      session,
      child,
      pending: new Map(),
      nextRequestId: 1,
      currentTurnId: null,
      threadTitle: null,
      providerThreadId: null,
      stopped: false,
    };

    this._sessions.set(input.threadId, ctx);

    /* Wire up stdout line reader */
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this._handleLine(input.threadId, ctx, line));

    /* Wire up stderr logging */
    const stderrRl = createInterface({ input: child.stderr });
    stderrRl.on("line", (rawLine) => {
      const line = rawLine.replace(ANSI_ESCAPE_REGEX, "").trim();
      if (line) console.error(`[codex-adapter][stderr] ${line}`);
    });

    /* Process lifecycle */
    child.on("error", (err) => {
      console.error(`[codex-adapter] process error for ${input.threadId}:`, err.message);
      ctx.session.status = "error";
      ctx.session.lastError = err.message;
      this._offerRuntimeEvent(makeEvent(EventType.ERROR, err.message));
      this._offerRuntimeEvent(makeEvent(EventType.DONE));
    });

    child.on("exit", (code) => {
      console.error(`[codex-adapter] process exited for ${input.threadId} with code ${code}`);
      ctx.session.status = "closed";
      if (ctx.currentTurnId) {
        ctx.currentTurnId = null;
        if (code !== 0) {
          this._offerRuntimeEvent(
            makeEvent(EventType.ERROR, `codex process exited with code ${code}`),
          );
        }
        this._offerRuntimeEvent(makeEvent(EventType.DONE));
      }
      /* Reject any pending requests */
      for (const [id, p] of ctx.pending) {
        clearTimeout(p.timeout);
        p.reject(new Error(`codex process exited during ${p.method}`));
        ctx.pending.delete(id);
      }
    });

    /* Perform JSON-RPC handshake */
    try {
      await this._sendRequest(ctx, "initialize", {
        clientInfo: {
          name: "agent_remote",
          title: "Agent Remote",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });

      /* Send initialized notification */
      this._writeMessage(ctx, { method: "initialized" });

      /* Start a thread (matches t3code's threadStartParams shape) */
      const threadStartParams: Record<string, unknown> = {
        model,
        cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        experimentalRawEvents: false,
      };
      if (input.resumeCursor && typeof input.resumeCursor === "string") {
        threadStartParams.threadId = input.resumeCursor;
      }
      const threadResponse = await this._sendRequest<Record<string, unknown>>(ctx, "thread/start", threadStartParams);

      /* Extract provider-assigned thread ID from response */
      const threadObj = threadResponse?.thread as Record<string, unknown> | undefined;
      const providerThreadId =
        (typeof threadObj?.id === "string" ? threadObj.id : null) ??
        (typeof threadResponse?.threadId === "string" ? threadResponse.threadId as string : null);
      if (providerThreadId) {
        ctx.providerThreadId = providerThreadId;
        session.resumeCursor = { threadId: providerThreadId };
      }

      session.status = "ready";
      session.updatedAt = new Date().toISOString();
      console.error(`[codex-adapter] session ready for thread ${input.threadId} (provider=${providerThreadId})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      session.status = "error";
      session.lastError = msg;
      this._killChild(ctx);
      this._sessions.delete(input.threadId);
      throw new Error(`Failed to initialize codex session: ${msg}`);
    }

    return session;
  }

  /* ── Send turn ── */

  override async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    console.error(
      `[codex-adapter] sendTurn threadId=${input.threadId} input=${input.input?.slice(0, 50)}...`,
    );

    const ctx = this._sessions.get(input.threadId);
    if (!ctx) {
      throw new Error(`session not found for thread ${input.threadId}`);
    }

    const turnId = randomUUID();
    ctx.currentTurnId = turnId;
    ctx.session.status = "running";
    ctx.session.activeTurnId = turnId;
    ctx.session.updatedAt = new Date().toISOString();

    /* Send turn/start request (matches t3code's turnStartParams shape) */
    if (!ctx.providerThreadId) {
      throw new Error("No provider thread ID — session was not properly initialized");
    }

    try {
      const turnResponse = await this._sendRequest<Record<string, unknown>>(ctx, "turn/start", {
        threadId: ctx.providerThreadId,
        input: [{ type: "text", text: input.input ?? "", text_elements: [] }],
      });

      /* Extract provider turn ID if available */
      const turnObj = turnResponse?.turn as Record<string, unknown> | undefined;
      const providerTurnId = typeof turnObj?.id === "string" ? turnObj.id : null;
      if (providerTurnId) {
        ctx.session.activeTurnId = providerTurnId;
      }
    } catch (e) {
      /* If the request itself fails, emit error + done */
      const msg = e instanceof Error ? e.message : String(e);
      this._offerRuntimeEvent(makeEvent(EventType.ERROR, msg));
      this._offerRuntimeEvent(makeEvent(EventType.DONE));
      ctx.currentTurnId = null;
      ctx.session.status = "ready";
      ctx.session.activeTurnId = undefined;
    }

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: ctx.session.resumeCursor,
    };
  }

  /* ── Interrupt ── */

  override async interruptTurn(threadId: string, _turnId?: string): Promise<void> {
    const ctx = this._sessions.get(threadId);
    if (!ctx) return;

    try {
      await this._sendRequest(ctx, "turn/interrupt", {}, 5000);
    } catch {
      /* best-effort */
    }

    ctx.currentTurnId = null;
    ctx.session.status = "ready";
    ctx.session.activeTurnId = undefined;
    ctx.session.updatedAt = new Date().toISOString();
  }

  /* ── Stop session ── */

  override async stopSession(threadId: string): Promise<void> {
    const ctx = this._sessions.get(threadId);
    if (!ctx) return;
    this._sessions.delete(threadId);
    ctx.stopped = true;
    this._killChild(ctx);
  }

  /* ── Stream events ── */

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

  getSessionId(threadId: string): string | null {
    const ctx = this._sessions.get(threadId);
    return ctx?.providerThreadId ?? null;
  }

  override async cancel(): Promise<void> {
    const sessionIds = Array.from(this._sessions.keys());
    for (const threadId of sessionIds) {
      await this.stopSession(threadId);
    }
  }

  /* ── Internal: JSON-RPC line handler ── */

  private _handleLine(threadId: string, ctx: CodexSessionContext, raw: string): void {
    const line = raw.trim();
    if (!line) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      console.error(`[codex-adapter] invalid JSON from codex: ${line.slice(0, 200)}`);
      return;
    }

    const hasId = "id" in msg && msg.id != null;
    const hasMethod = "method" in msg && typeof msg.method === "string";

    if (hasId && hasMethod) {
      /* Server request — needs a response from us */
      this._handleServerRequest(ctx, msg as JsonRpcRequest);
    } else if (hasId && !hasMethod) {
      /* Response to a pending request */
      this._handleResponse(ctx, msg as JsonRpcResponse);
    } else if (hasMethod) {
      /* Server notification */
      this._handleNotification(threadId, ctx, msg as JsonRpcNotification);
    }
  }

  /* ── Handle server requests (approval, user input) ── */

  private _handleServerRequest(ctx: CodexSessionContext, req: JsonRpcRequest): void {
    /* Auto-approve all approval requests */
    if (
      req.method.includes("requestApproval") ||
      req.method.includes("requestUserInput")
    ) {
      console.error(`[codex-adapter] auto-approving: ${req.method}`);

      if (req.method.includes("requestUserInput")) {
        /* For user input requests, respond with empty string */
        this._writeMessage(ctx, {
          id: req.id,
          result: { input: "" },
        });
      } else {
        /* For approval requests, approve */
        this._writeMessage(ctx, {
          id: req.id,
          result: { approved: true },
        });
      }
      return;
    }

    /* Unknown server request — respond with error to not block the server */
    console.error(`[codex-adapter] unknown server request: ${req.method}`);
    this._writeMessage(ctx, {
      id: req.id,
      error: { code: -32601, message: `Method not handled: ${req.method}` },
    });
  }

  /* ── Handle responses to our requests ── */

  private _handleResponse(ctx: CodexSessionContext, resp: JsonRpcResponse): void {
    const id = String(resp.id);
    const pending = ctx.pending.get(id);
    if (!pending) {
      console.error(`[codex-adapter] response for unknown request id=${id}`);
      return;
    }
    ctx.pending.delete(id);
    clearTimeout(pending.timeout);

    if (resp.error) {
      pending.reject(
        new Error(resp.error.message ?? `RPC error code=${resp.error.code}`),
      );
    } else {
      pending.resolve(resp.result);
    }
  }

  /* ── Handle server notifications (streaming, turn lifecycle) ── */

  private _handleNotification(
    _threadId: string,
    ctx: CodexSessionContext,
    notif: JsonRpcNotification,
  ): void {
    const params = (notif.params ?? {}) as Record<string, unknown>;

    switch (notif.method) {
      case "item/agentMessage/delta": {
        /* Streaming text delta */
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta) {
          this._offerRuntimeEvent(makeEvent(EventType.TEXT_DELTA, delta));
        }
        return;
      }

      case "item/thinkingMessage/delta": {
        /* Reasoning/thinking delta */
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta) {
          this._offerRuntimeEvent(
            makeEvent(EventType.TEXT_DELTA, delta, { streamKind: "reasoning_text" }),
          );
        }
        return;
      }

      case "turn/completed": {
        /* Turn is done */
        const error = params.error as Record<string, unknown> | undefined;
        if (error && error.message) {
          this._offerRuntimeEvent(
            makeEvent(EventType.ERROR, String(error.message)),
          );
        }

        /* Extract thread title if available */
        const title = params.title ?? params.threadTitle;
        if (typeof title === "string" && title.trim()) {
          ctx.threadTitle = title.trim();
        }

        ctx.currentTurnId = null;
        ctx.session.status = "ready";
        ctx.session.activeTurnId = undefined;
        ctx.session.updatedAt = new Date().toISOString();
        this._offerRuntimeEvent(makeEvent(EventType.DONE));
        return;
      }

      case "turn/started": {
        /* Turn accepted — no action needed */
        return;
      }

      case "thread/started": {
        /* Capture provider thread ID if present */
        const threadObj = params.thread as Record<string, unknown> | undefined;
        const tid = typeof threadObj?.id === "string" ? threadObj.id : null;
        if (tid) {
          ctx.providerThreadId = tid;
          ctx.session.resumeCursor = { threadId: tid };
        }
        return;
      }

      case "item/tool/start": {
        const toolName = typeof params.name === "string" ? params.name : "tool";
        this._offerRuntimeEvent(makeEvent(EventType.TOOL_START, toolName));
        return;
      }

      case "item/tool/result": {
        const toolName = typeof params.name === "string" ? params.name : "tool";
        this._offerRuntimeEvent(makeEvent(EventType.TOOL_RESULT, toolName));
        return;
      }

      case "error": {
        const message =
          typeof params.message === "string"
            ? params.message
            : JSON.stringify(params);
        console.error(`[codex-adapter] server error notification: ${message}`);
        /* Only emit if it's fatal (willRetry = false) */
        const willRetry = params.willRetry === true;
        if (!willRetry) {
          this._offerRuntimeEvent(makeEvent(EventType.ERROR, message));
        }
        return;
      }

      default:
        return;
    }
  }

  /* ── Internal: send JSON-RPC request ── */

  private _sendRequest<T = unknown>(
    ctx: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<T> {
    const id = ctx.nextRequestId++;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ctx.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      ctx.pending.set(String(id), {
        method,
        timeout,
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      this._writeMessage(ctx, { method, id, params });
    });
  }

  /* ── Internal: write JSON-RPC message ── */

  private _writeMessage(ctx: CodexSessionContext, message: unknown): void {
    const encoded = JSON.stringify(message);
    if (!ctx.child.stdin.writable) {
      console.error(`[codex-adapter] cannot write to codex stdin (not writable)`);
      return;
    }
    ctx.child.stdin.write(`${encoded}\n`);
  }

  /* ── Internal: kill child process ── */

  private _killChild(ctx: CodexSessionContext): void {
    try {
      if (!ctx.child.killed) {
        ctx.child.stdin.end();
        ctx.child.kill("SIGTERM");
      }
    } catch {}

    /* Clean up pending requests */
    for (const [id, p] of ctx.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error("session stopped"));
      ctx.pending.delete(id);
    }
  }

  /* ── Internal: event queue ── */

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
}
