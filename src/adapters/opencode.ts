import { randomUUID } from "node:crypto";
import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type OpenCodeSpawnFn = typeof defaultSpawn;
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

/* ── opencode JSON event shapes (subset we care about) ── */

interface OpenCodeStepStart {
  type: "step_start";
  sessionID: string;
  part?: { messageID?: string };
}

interface OpenCodeTextPart {
  type: "text";
  sessionID: string;
  part: { type: "text"; text: string };
}

interface OpenCodeToolUsePart {
  type: "tool_use";
  sessionID: string;
  part: {
    type: "tool";
    tool: string;
    state?: { status?: string; title?: string };
  };
}

interface OpenCodeStepFinish {
  type: "step_finish";
  sessionID: string;
  part: {
    type: "step-finish";
    reason?: string;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
}

interface OpenCodeErrorEvent {
  type: "error";
  sessionID?: string;
  message?: string;
  error?: { message?: string };
}

type OpenCodeEvent =
  | OpenCodeStepStart
  | OpenCodeTextPart
  | OpenCodeToolUsePart
  | OpenCodeStepFinish
  | OpenCodeErrorEvent
  | { type: string; [k: string]: unknown };

/* ── Per-thread session context ── */

interface OpenCodeSessionContext {
  session: ProviderSession;
  providerSessionId: string | null;
  currentTurnId: string | null;
  threadTitle: string | null;
  child: ChildProcessWithoutNullStreams | null;
  stopped: boolean;
  inputTokens: number;
  outputTokens: number;
  emittedTextThisTurn: boolean;
  emittedToolThisTurn: boolean;
}

const MAX_QUEUE = 65536;

export class OpenCodeCliAdapter extends BaseAdapter {
  readonly provider = "opencode";

  private _model: string;
  private _binaryPath: string;
  private _defaultCwd: string;
  private _spawn: OpenCodeSpawnFn;
  private _sessions = new Map<string, OpenCodeSessionContext>();
  private _runtimeEventQueue: Array<AdapterEvent> = [];
  private _runtimeEventWaiters: Array<(ev: AdapterEvent | null) => void> = [];
  private _lastSpawnArgs: ReadonlyArray<string> | null = null;

  constructor(settings: Settings, opts?: { spawnFn?: OpenCodeSpawnFn }) {
    super();
    this._model = (settings.opencodeModel ?? "").trim();
    this._binaryPath = (settings.opencodeBinaryPath ?? "").trim() || "opencode";
    const cw = (settings.claudeWorkspaceCwd ?? "").trim();
    this._defaultCwd = cw || process.cwd();
    this._spawn = opts?.spawnFn ?? defaultSpawn;
  }

  /** Test/inspection helper: most recent argv passed to spawn. */
  getLastSpawnArgs(): ReadonlyArray<string> | null {
    return this._lastSpawnArgs;
  }

  /* ── startSession: opencode runs per-turn, so this just records context ── */

  override async startSession(input: {
    threadId: string;
    cwd?: string;
    model?: string;
    resumeCursor?: unknown;
  }): Promise<ProviderSession> {
    const cwd = input.cwd || this._defaultCwd;
    const model = input.model || this._model;

    if (this._sessions.has(input.threadId)) {
      throw new Error(`session already started for thread ${input.threadId}`);
    }

    let providerSessionId: string | null = null;
    if (typeof input.resumeCursor === "string" && input.resumeCursor) {
      providerSessionId = input.resumeCursor;
    } else if (
      input.resumeCursor &&
      typeof input.resumeCursor === "object" &&
      "sessionId" in (input.resumeCursor as Record<string, unknown>)
    ) {
      const sid = (input.resumeCursor as Record<string, unknown>).sessionId;
      if (typeof sid === "string") providerSessionId = sid;
    }

    const now = new Date().toISOString();
    const session: ProviderSession = {
      threadId: input.threadId,
      status: "ready",
      cwd,
      model,
      resumeCursor: providerSessionId ?? input.resumeCursor,
      createdAt: now,
      updatedAt: now,
    };

    const ctx: OpenCodeSessionContext = {
      session,
      providerSessionId,
      currentTurnId: null,
      threadTitle: null,
      child: null,
      stopped: false,
      inputTokens: 0,
      outputTokens: 0,
      emittedTextThisTurn: false,
      emittedToolThisTurn: false,
    };
    this._sessions.set(input.threadId, ctx);
    return session;
  }

  /* ── sendTurn: spawn `opencode run` per turn ── */

  override async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const ctx = this._sessions.get(input.threadId);
    if (!ctx) throw new Error(`session not found for thread ${input.threadId}`);
    if (ctx.child) throw new Error(`turn already in progress for thread ${input.threadId}`);

    const turnId = randomUUID();
    ctx.currentTurnId = turnId;
    ctx.session.status = "running";
    ctx.session.activeTurnId = turnId;
    ctx.session.updatedAt = new Date().toISOString();
    ctx.inputTokens = 0;
    ctx.outputTokens = 0;
    ctx.emittedTextThisTurn = false;
    ctx.emittedToolThisTurn = false;

    const args = ["run", "--format", "json", "--log-level", "ERROR"];
    if (ctx.providerSessionId) {
      args.push("--session", ctx.providerSessionId);
    }
    if (ctx.session.model) {
      args.push("--model", ctx.session.model);
    }
    if (ctx.session.cwd) {
      args.push("--dir", ctx.session.cwd);
    }

    this._lastSpawnArgs = args.slice();
    const child = this._spawn(this._binaryPath, args, {
      cwd: ctx.session.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    ctx.child = child;

    /* Write the user's message via stdin and close it. */
    try {
      child.stdin.write(input.input ?? "");
      child.stdin.end();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[opencode-adapter] stdin write failed: ${msg}`);
    }

    /* Stdout: parse JSON events */
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this._handleStdoutLine(ctx, line));

    /* Stderr: log */
    const stderrRl = createInterface({ input: child.stderr });
    stderrRl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) console.error(`[opencode-adapter][stderr] ${trimmed}`);
    });

    child.on("error", (err) => {
      console.error(`[opencode-adapter] process error: ${err.message}`);
      this._offerRuntimeEvent(makeEvent(EventType.ERROR, err.message));
      this._finalizeTurn(ctx);
    });

    child.on("exit", (code, signal) => {
      ctx.child = null;
      if (ctx.stopped) return;
      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
        this._offerRuntimeEvent(
          makeEvent(EventType.ERROR, `opencode exited with code ${code}`),
        );
      }
      this._finalizeTurn(ctx);
    });

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: ctx.session.resumeCursor,
    };
  }

  /* ── interruptTurn ── */

  override async interruptTurn(threadId: string, _turnId?: string): Promise<void> {
    const ctx = this._sessions.get(threadId);
    if (!ctx) return;
    if (ctx.child && !ctx.child.killed) {
      try {
        ctx.child.kill("SIGTERM");
      } catch {}
    }
  }

  /* ── stopSession ── */

  override async stopSession(threadId: string): Promise<void> {
    const ctx = this._sessions.get(threadId);
    if (!ctx) return;
    this._sessions.delete(threadId);
    ctx.stopped = true;
    if (ctx.child && !ctx.child.killed) {
      try {
        ctx.child.kill("SIGTERM");
      } catch {}
    }
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
    return this._sessions.get(threadId)?.threadTitle ?? null;
  }

  override getSessionModel(threadId: string): string | null {
    return this._sessions.get(threadId)?.session.model ?? null;
  }

  getSessionId(threadId: string): string | null {
    return this._sessions.get(threadId)?.providerSessionId ?? null;
  }

  override async cancel(): Promise<void> {
    const ids = Array.from(this._sessions.keys());
    for (const id of ids) await this.stopSession(id);
  }

  /* ── Internal: stdout JSON-line handler ── */

  private _handleStdoutLine(ctx: OpenCodeSessionContext, raw: string): void {
    const line = raw.trim();
    if (!line) return;
    if (!line.startsWith("{")) return;

    let ev: OpenCodeEvent;
    try {
      ev = JSON.parse(line) as OpenCodeEvent;
    } catch {
      console.error(`[opencode-adapter] invalid JSON: ${line.slice(0, 200)}`);
      return;
    }

    const sessionID =
      typeof (ev as Record<string, unknown>).sessionID === "string"
        ? ((ev as Record<string, unknown>).sessionID as string)
        : null;
    if (sessionID && !ctx.providerSessionId) {
      ctx.providerSessionId = sessionID;
      ctx.session.resumeCursor = sessionID;
    }

    switch (ev.type) {
      case "step_start":
        return;

      case "text": {
        const part = (ev as OpenCodeTextPart).part;
        const text = typeof part?.text === "string" ? part.text : "";
        if (text.length > 0) {
          ctx.emittedTextThisTurn = true;
          this._offerRuntimeEvent(makeEvent(EventType.TEXT_DELTA, text));
        }
        return;
      }

      case "tool_use": {
        const part = (ev as OpenCodeToolUsePart).part;
        const toolName = typeof part?.tool === "string" ? part.tool : "tool";
        const status = part?.state?.status;
        ctx.emittedToolThisTurn = true;
        this._offerRuntimeEvent(makeEvent(EventType.TOOL_START, toolName));
        if (status === "completed" || status === "error") {
          this._offerRuntimeEvent(makeEvent(EventType.TOOL_RESULT, toolName));
        }
        return;
      }

      case "step_finish": {
        const part = (ev as OpenCodeStepFinish).part;
        const tokens = part?.tokens;
        if (tokens) {
          if (typeof tokens.input === "number") ctx.inputTokens += tokens.input;
          if (typeof tokens.output === "number") ctx.outputTokens += tokens.output;
        }
        return;
      }

      case "error": {
        const e = ev as OpenCodeErrorEvent;
        const msg =
          (typeof e.message === "string" && e.message) ||
          (e.error && typeof e.error.message === "string" ? e.error.message : "") ||
          JSON.stringify(ev);
        this._offerRuntimeEvent(makeEvent(EventType.ERROR, msg));
        return;
      }

      default:
        return;
    }
  }

  private _finalizeTurn(ctx: OpenCodeSessionContext): void {
    if (!ctx.currentTurnId) return;
    const doneMeta: Record<string, unknown> = {};
    if (ctx.inputTokens > 0) doneMeta.inputTokens = ctx.inputTokens;
    if (ctx.outputTokens > 0) doneMeta.outputTokens = ctx.outputTokens;

    ctx.currentTurnId = null;
    ctx.session.status = "ready";
    ctx.session.activeTurnId = undefined;
    ctx.session.updatedAt = new Date().toISOString();
    this._offerRuntimeEvent(
      makeEvent(EventType.DONE, "", Object.keys(doneMeta).length > 0 ? doneMeta : null),
    );

    ctx.inputTokens = 0;
    ctx.outputTokens = 0;
  }

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
