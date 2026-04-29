import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { OpenCodeCliAdapter, type OpenCodeSpawnFn } from "../src/adapters/opencode.js";
import { EventType, type AdapterEvent } from "../src/adapters/base.js";
import type { Settings } from "../src/config.js";
import { buildChatAdapter } from "../src/adapters/factory.js";
import { loadSettings } from "../src/config.js";
import { CodexCliAdapter } from "../src/adapters/codex.js";
import { ClaudeAgentSdkAdapter } from "../src/adapters/claude.js";
import {
  PROVIDERS,
  PROVIDER_MODELS,
  PROVIDER_EMOJI_NAMES,
  PROVIDER_CATEGORY_NAME_UNICODE_PREFIX,
} from "../src/constants.js";

/* ── Fake settings ── */

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  const base: Settings = {
    discordBotToken: "",
    discordApplicationId: "",
    discordGuildId: "",
    databaseUrl: "",
    enabledProviders: "opencode",
    anthropicApiKey: "",
    claudeModel: "sonnet",
    claudeCodeBinaryPath: "",
    claudeWorkspaceCwd: "",
    claudeEffort: "",
    claudeThinking: false,
    claudeFastMode: false,
    openaiApiKey: "",
    codexModel: "gpt-5.4",
    codexBinaryPath: "",
    codexHomePath: "",
    opencodeModel: "opencode/claude-sonnet-4-6",
    opencodeBinaryPath: "/usr/local/bin/opencode",
    encryptionKey: "",
    apiHost: "",
    apiPort: 0,
    accessEnvDefaults: { ownerUserId: "", allowedUserIds: [], restrictToWhitelist: false },
    enabledProviderKeys() {
      return ["opencode"];
    },
  };
  return { ...base, ...overrides };
}

/* ── Fake child process ── */

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  killSignal: NodeJS.Signals | null;
  kill: (sig?: NodeJS.Signals | number) => boolean;
  /** Helpers */
  emitLine: (line: string) => void;
  emitStderr: (line: string) => void;
  exit: (code: number, signal?: NodeJS.Signals) => void;
  errorOut: (err: Error) => void;
  stdinChunks: Buffer[];
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  const stdinChunks: Buffer[] = [];
  ee.stdinChunks = stdinChunks;

  ee.stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      cb();
    },
  });

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  ee.stdout = stdout;
  ee.stderr = stderr;
  ee.killed = false;
  ee.killSignal = null;

  ee.kill = (sig: NodeJS.Signals | number = "SIGTERM") => {
    ee.killed = true;
    ee.killSignal = (typeof sig === "string" ? sig : "SIGTERM") as NodeJS.Signals;
    return true;
  };
  ee.emitLine = (line: string) => stdout.push(line + "\n");
  ee.emitStderr = (line: string) => stderr.push(line + "\n");
  ee.exit = (code: number, signal?: NodeJS.Signals) => {
    /* End stdout/stderr so readline closes deterministically. */
    stdout.push(null);
    stderr.push(null);
    /* setImmediate runs in the check phase, after any pending readline 'line'
       callbacks fired during the poll phase — guarantees all stdout lines
       have been parsed before the adapter sees 'exit'. */
    setImmediate(() => ee.emit("exit", code, signal ?? null));
  };
  ee.errorOut = (err: Error) => ee.emit("error", err);

  return ee;
}

/* Spawn factory that captures the fake child for the test to drive. */
function makeFakeSpawner(): { spawnFn: OpenCodeSpawnFn; getChild: () => FakeChild | null; calls: Array<{ cmd: string; args: ReadonlyArray<string> }> } {
  let last: FakeChild | null = null;
  const calls: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
  const spawnFn = ((cmd: string, args?: ReadonlyArray<string>) => {
    calls.push({ cmd, args: args ?? [] });
    last = makeFakeChild();
    return last as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as OpenCodeSpawnFn;
  return { spawnFn, getChild: () => last, calls };
}

/* ── Helpers to consume events ── */

async function collect(
  iter: AsyncGenerator<AdapterEvent, void, undefined>,
  count: number,
  timeoutMs = 2000,
): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  const timer = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`timed out collecting ${count} events; got ${out.length}`)), timeoutMs),
  );
  const consume = (async () => {
    for await (const ev of iter) {
      out.push(ev);
      if (out.length >= count) return out;
    }
    return out;
  })();
  return Promise.race([consume, timer]);
}

/* ── Tests ── */

describe("OpenCodeCliAdapter — construction", () => {
  test("provider key is opencode", () => {
    const a = new OpenCodeCliAdapter(makeSettings());
    expect(a.provider).toBe("opencode");
  });

  test("falls back to 'opencode' when binary path empty", () => {
    const { spawnFn } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings({ opencodeBinaryPath: "" }), { spawnFn });
    /* indirect: just ensure construction doesn't throw and provider is correct */
    expect(a.provider).toBe("opencode");
  });
});

describe("OpenCodeCliAdapter — startSession", () => {
  test("registers a ready session", async () => {
    const a = new OpenCodeCliAdapter(makeSettings());
    const s = await a.startSession({ threadId: "t1", cwd: "/tmp/wsx" });
    expect(s.threadId).toBe("t1");
    expect(s.status).toBe("ready");
    expect(s.cwd).toBe("/tmp/wsx");
    expect(s.model).toBe("opencode/claude-sonnet-4-6");
    expect(await a.hasSession("t1")).toBe(true);
    const list = await a.listSessions();
    expect(list.length).toBe(1);
  });

  test("rejects duplicate startSession", async () => {
    const a = new OpenCodeCliAdapter(makeSettings());
    await a.startSession({ threadId: "t1" });
    await expect(a.startSession({ threadId: "t1" })).rejects.toThrow(/already started/);
  });

  test("string resumeCursor populates providerSessionId", async () => {
    const a = new OpenCodeCliAdapter(makeSettings());
    await a.startSession({ threadId: "t1", resumeCursor: "ses_existing" });
    expect(a.getSessionId("t1")).toBe("ses_existing");
  });

  test("object resumeCursor with sessionId field is honored", async () => {
    const a = new OpenCodeCliAdapter(makeSettings());
    await a.startSession({ threadId: "t1", resumeCursor: { sessionId: "ses_existing2" } });
    expect(a.getSessionId("t1")).toBe("ses_existing2");
  });
});

describe("OpenCodeCliAdapter — sendTurn argv", () => {
  test("first turn has no --session flag and writes message to stdin", async () => {
    const { spawnFn, getChild, calls } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1", cwd: "/tmp/wsx" });
    await a.sendTurn({ threadId: "t1", input: "hello world" });

    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe("/usr/local/bin/opencode");
    const args = calls[0].args;
    expect(args).toContain("run");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args.indexOf("--session")).toBe(-1);
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("opencode/claude-sonnet-4-6");
    expect(args).toContain("--dir");
    expect(args[args.indexOf("--dir") + 1]).toBe("/tmp/wsx");

    const child = getChild()!;
    expect(Buffer.concat(child.stdinChunks).toString()).toBe("hello world");

    /* clean up so the test process doesn't hang on the runtime stream */
    child.exit(0);
    await a.stopSession("t1");
  });

  test("subsequent turn uses captured providerSessionId via --session", async () => {
    const { spawnFn, getChild, calls } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });

    /* turn 1 */
    await a.sendTurn({ threadId: "t1", input: "hi" });
    const c1 = getChild()!;
    c1.emitLine(JSON.stringify({ type: "step_start", sessionID: "ses_abc", part: { type: "step-start" } }));
    c1.emitLine(JSON.stringify({ type: "text", sessionID: "ses_abc", part: { type: "text", text: "hello back" } }));
    c1.emitLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_abc",
        part: { type: "step-finish", reason: "stop", tokens: { input: 3, output: 4 } },
      }),
    );

    /* Wait until DONE arrives so providerSessionId is captured before turn 2. */
    c1.exit(0);
    /* step_start is swallowed; we expect TEXT_DELTA + DONE. */
    const ev = await collect(a.streamEvents(), 2);
    expect(ev.some((e) => e.type === EventType.TEXT_DELTA && e.data === "hello back")).toBe(true);
    expect(ev.some((e) => e.type === EventType.DONE)).toBe(true);

    expect(a.getSessionId("t1")).toBe("ses_abc");

    /* turn 2 */
    await a.sendTurn({ threadId: "t1", input: "again" });
    const args2 = calls[1].args;
    const idx = args2.indexOf("--session");
    expect(idx).toBeGreaterThan(-1);
    expect(args2[idx + 1]).toBe("ses_abc");

    getChild()!.exit(0);
    await a.stopSession("t1");
  });

  test("rejects sendTurn for unknown thread", async () => {
    const a = new OpenCodeCliAdapter(makeSettings());
    await expect(a.sendTurn({ threadId: "nope", input: "x" })).rejects.toThrow(/session not found/);
  });

  test("rejects sendTurn while a turn is in flight", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "first" });
    await expect(a.sendTurn({ threadId: "t1", input: "second" })).rejects.toThrow(/already in progress/);
    getChild()!.exit(0);
    await a.stopSession("t1");
  });
});

describe("OpenCodeCliAdapter — event parsing", () => {
  test("text part emits TEXT_DELTA with full text", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    child.emitLine(JSON.stringify({ type: "text", sessionID: "ses_x", part: { type: "text", text: "Hello." } }));
    child.emitLine(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { type: "step-finish", reason: "stop" } }));
    child.exit(0);

    const events = await collect(a.streamEvents(), 2);
    expect(events[0]).toEqual(expect.objectContaining({ type: EventType.TEXT_DELTA, data: "Hello." }));
    expect(events[1].type).toBe(EventType.DONE);
    await a.stopSession("t1");
  });

  test("tool_use emits TOOL_START and TOOL_RESULT when state is completed", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    child.emitLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_x",
        part: { type: "tool", tool: "bash", state: { status: "completed" } },
      }),
    );
    child.emitLine(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { type: "step-finish", reason: "stop" } }));
    child.exit(0);

    const events = await collect(a.streamEvents(), 3);
    expect(events[0]).toEqual(expect.objectContaining({ type: EventType.TOOL_START, data: "bash" }));
    expect(events[1]).toEqual(expect.objectContaining({ type: EventType.TOOL_RESULT, data: "bash" }));
    expect(events[2].type).toBe(EventType.DONE);
    await a.stopSession("t1");
  });

  test("tool_use without completed status emits only TOOL_START", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    child.emitLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_x",
        part: { type: "tool", tool: "edit", state: { status: "running" } },
      }),
    );
    child.emitLine(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { type: "step-finish", reason: "stop" } }));
    child.exit(0);

    const events = await collect(a.streamEvents(), 2);
    expect(events[0].type).toBe(EventType.TOOL_START);
    expect(events[0].data).toBe("edit");
    expect(events[1].type).toBe(EventType.DONE);
    await a.stopSession("t1");
  });

  test("error event emits ERROR", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    child.emitLine(JSON.stringify({ type: "error", sessionID: "ses_x", message: "rate-limited" }));
    child.exit(0);

    const events = await collect(a.streamEvents(), 2);
    expect(events[0]).toEqual(expect.objectContaining({ type: EventType.ERROR, data: "rate-limited" }));
    expect(events[1].type).toBe(EventType.DONE);
    await a.stopSession("t1");
  });

  test("nonzero exit (without explicit error event) emits ERROR + DONE", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    child.exit(7);

    const events = await collect(a.streamEvents(), 2);
    expect(events[0].type).toBe(EventType.ERROR);
    expect(events[0].data).toContain("code 7");
    expect(events[1].type).toBe(EventType.DONE);
    await a.stopSession("t1");
  });

  test("garbage stdout lines are skipped without crashing", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    child.emitLine("not even close to json");
    child.emitLine("{this is also broken");
    child.emitLine(""); // blank
    child.emitLine(JSON.stringify({ type: "text", sessionID: "ses_x", part: { type: "text", text: "ok" } }));
    child.emitLine(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { type: "step-finish", reason: "stop" } }));
    child.exit(0);

    const events = await collect(a.streamEvents(), 2);
    expect(events[0].data).toBe("ok");
    expect(events[1].type).toBe(EventType.DONE);
    await a.stopSession("t1");
  });

  test("token usage is summed across step_finish events and reported on DONE", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    child.emitLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_x",
        part: { type: "step-finish", reason: "tool-calls", tokens: { input: 10, output: 20 } },
      }),
    );
    child.emitLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_x",
        part: { type: "step-finish", reason: "stop", tokens: { input: 5, output: 30 } },
      }),
    );
    child.exit(0);

    const events = await collect(a.streamEvents(), 1);
    const done = events[0];
    expect(done.type).toBe(EventType.DONE);
    expect(done.metadata).toEqual({ inputTokens: 15, outputTokens: 50 });
    await a.stopSession("t1");
  });

  test("process error emits ERROR + DONE", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    child.errorOut(new Error("ENOENT"));
    /* Implementation calls _finalizeTurn on 'error' which emits DONE.
       It does not auto-exit; we still need exit to fully clean up streams. */
    child.exit(0);

    const events = await collect(a.streamEvents(), 2);
    expect(events[0].type).toBe(EventType.ERROR);
    expect(events[0].data).toBe("ENOENT");
    expect(events[1].type).toBe(EventType.DONE);
    await a.stopSession("t1");
  });
});

describe("OpenCodeCliAdapter — turn lifecycle bookkeeping", () => {
  test("session status flips ready → running → ready around a turn", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    const s = await a.startSession({ threadId: "t1" });
    expect(s.status).toBe("ready");
    await a.sendTurn({ threadId: "t1", input: "x" });
    const list1 = await a.listSessions();
    expect(list1[0].status).toBe("running");
    expect(list1[0].activeTurnId).toBeDefined();

    const child = getChild()!;
    child.emitLine(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { type: "step-finish", reason: "stop" } }));
    child.exit(0);

    await collect(a.streamEvents(), 1);
    const list2 = await a.listSessions();
    expect(list2[0].status).toBe("ready");
    expect(list2[0].activeTurnId).toBeUndefined();
    await a.stopSession("t1");
  });
});

describe("OpenCodeCliAdapter — interrupt & stop", () => {
  test("interruptTurn sends SIGTERM to running child", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    expect(child.killed).toBe(false);
    await a.interruptTurn("t1");
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");
    child.exit(0, "SIGTERM");
    await a.stopSession("t1");
  });

  test("interruptTurn on unknown thread is a no-op", async () => {
    const a = new OpenCodeCliAdapter(makeSettings());
    await expect(a.interruptTurn("nothing")).resolves.toBeUndefined();
  });

  test("stopSession removes the session and kills child", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    await a.stopSession("t1");
    expect(child.killed).toBe(true);
    expect(await a.hasSession("t1")).toBe(false);
  });

  test("interrupt-induced SIGTERM exit does not emit a synthetic ERROR", async () => {
    const { spawnFn, getChild } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.sendTurn({ threadId: "t1", input: "x" });
    const child = getChild()!;
    await a.interruptTurn("t1");
    child.exit(143, "SIGTERM");
    const events = await collect(a.streamEvents(), 1);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.DONE);
    await a.stopSession("t1");
  });

  test("cancel() shuts down all sessions", async () => {
    const { spawnFn } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.startSession({ threadId: "t2" });
    expect((await a.listSessions()).length).toBe(2);
    await a.cancel();
    expect((await a.listSessions()).length).toBe(0);
  });
});

describe("OpenCodeCliAdapter — multi-thread isolation", () => {
  test("two threads have independent provider session IDs", async () => {
    const { spawnFn, getChild, calls } = makeFakeSpawner();
    const a = new OpenCodeCliAdapter(makeSettings(), { spawnFn });
    await a.startSession({ threadId: "t1" });
    await a.startSession({ threadId: "t2" });

    await a.sendTurn({ threadId: "t1", input: "from t1" });
    const c1 = getChild()!;
    c1.emitLine(JSON.stringify({ type: "step_finish", sessionID: "ses_one", part: { type: "step-finish", reason: "stop" } }));
    c1.exit(0);
    await collect(a.streamEvents(), 1);

    await a.sendTurn({ threadId: "t2", input: "from t2" });
    const c2 = getChild()!;
    c2.emitLine(JSON.stringify({ type: "step_finish", sessionID: "ses_two", part: { type: "step-finish", reason: "stop" } }));
    c2.exit(0);
    await collect(a.streamEvents(), 1);

    expect(a.getSessionId("t1")).toBe("ses_one");
    expect(a.getSessionId("t2")).toBe("ses_two");
    /* No cross-contamination of --session args */
    expect(calls[0].args.indexOf("--session")).toBe(-1);
    expect(calls[1].args.indexOf("--session")).toBe(-1);
    await a.stopSession("t1");
    await a.stopSession("t2");
  });
});

describe("Adapter factory", () => {
  test("opencode key returns OpenCodeCliAdapter", () => {
    const a = buildChatAdapter("opencode", makeSettings());
    expect(a).toBeInstanceOf(OpenCodeCliAdapter);
    expect(a.provider).toBe("opencode");
  });
  test("codex key returns CodexCliAdapter", () => {
    const a = buildChatAdapter("codex", makeSettings());
    expect(a).toBeInstanceOf(CodexCliAdapter);
  });
  test("claude key returns ClaudeAgentSdkAdapter", () => {
    const a = buildChatAdapter("claude", makeSettings());
    expect(a).toBeInstanceOf(ClaudeAgentSdkAdapter);
  });
  test("unknown provider throws", () => {
    expect(() => buildChatAdapter("kiro", makeSettings())).toThrow(/not implemented/);
  });
});

describe("Settings & constants — opencode wiring", () => {
  test("loadSettings reads OPENCODE_MODEL and OPENCODE_BINARY_PATH", () => {
    process.env.OPENCODE_MODEL = "opencode/gpt-5.4";
    process.env.OPENCODE_BINARY_PATH = "/opt/oc/opencode";
    try {
      const s = loadSettings();
      expect(s.opencodeModel).toBe("opencode/gpt-5.4");
      expect(s.opencodeBinaryPath).toBe("/opt/oc/opencode");
    } finally {
      delete process.env.OPENCODE_MODEL;
      delete process.env.OPENCODE_BINARY_PATH;
    }
  });

  test("opencode appears in PROVIDERS, models, emoji, and category prefix tables", () => {
    expect(PROVIDERS.opencode).toBeDefined();
    expect(PROVIDERS.opencode.key).toBe("opencode");
    expect(PROVIDERS.opencode.categoryName).toBe("OpenCode");
    expect(PROVIDER_MODELS.opencode).toBeDefined();
    expect(PROVIDER_MODELS.opencode.length).toBeGreaterThan(0);
    expect(PROVIDER_MODELS.opencode.some((m) => m.isDefault)).toBe(true);
    expect(PROVIDER_EMOJI_NAMES.opencode).toBe("ar_opencode");
    expect(PROVIDER_CATEGORY_NAME_UNICODE_PREFIX.opencode).toBeTruthy();
  });
});
