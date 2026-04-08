import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { query, listSessions } from "@anthropic-ai/claude-agent-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

function err(obj) {
  process.stderr.write(`${JSON.stringify(obj)}\n`);
}

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function buildUserMessage(text) {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
}

const userQueue = [];
let wake = null;

function wakePrompt() {
  const w = wake;
  if (w) {
    wake = null;
    w();
  }
}

async function* promptInput() {
  for (;;) {
    while (userQueue.length === 0) {
      await new Promise((r) => {
        wake = r;
      });
    }
    yield userQueue.shift();
  }
}

function enqueueUser(text) {
  userQueue.push(buildUserMessage(text));
  wakePrompt();
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

const init = await new Promise((resolve, reject) => {
  rl.once("line", (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      reject(e);
      return;
    }
    if (parsed.cmd !== "init") {
      reject(new Error("first stdin line must be {\"cmd\":\"init\",...}"));
      return;
    }
    resolve(parsed);
  });
});

err({ bridge: "init received", cwd: init.cwd, model: init.model });

const cwd = typeof init.cwd === "string" && init.cwd.length > 0 ? init.cwd : process.cwd();
const binaryPath =
  typeof init.binaryPath === "string" && init.binaryPath.length > 0 ? init.binaryPath : "claude";
const pipeFile = typeof init.pipeFile === "string" ? init.pipeFile : null;
const isWindows = process.platform === "win32";

if (pipeFile) {
  err({ bridge: "using pipe file from init", pipeFile });
  writeFileSync(pipeFile, "");
}

const settings = {};
if (init.thinking === true) {
  settings.alwaysThinkingEnabled = true;
}
if (init.fastMode === true) {
  settings.fastMode = true;
}

const options = {
  cwd,
  pathToClaudeCodeExecutable: binaryPath,
  settingSources: ["user", "project", "local"],
  includePartialMessages: true,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  env: process.env,
  additionalDirectories: [cwd],
  canUseTool: async (toolName, toolInput, _callbackOptions) => {
    if (toolName === "AskUserQuestion") {
      return {
        behavior: "deny",
        message:
          "This bridge does not support AskUserQuestion; use full T3 Code for interactive prompts.",
      };
    }
    if (toolName === "ExitPlanMode") {
      return {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for user follow-up outside plan mode.",
      };
    }
    return { behavior: "allow", updatedInput: toolInput };
  },
};

if (typeof init.model === "string" && init.model.length > 0) {
  options.model = init.model;
}
if (typeof init.effort === "string" && init.effort.length > 0) {
  options.effort = init.effort;
}
if (Object.keys(settings).length > 0) {
  options.settings = settings;
}

if (!pipeFile) {
  const pipeDir = join(__dirname, ".pipe");
  mkdirSync(pipeDir, { recursive: true });
  const fallbackPipeFile = join(pipeDir, `bridge-${process.pid}.jsonl`);
  writeFileSync(fallbackPipeFile, "");
  err({ bridge: "fallback pipe file created", pipeFile: fallbackPipeFile });
}

let currentSessionId = null;

try {
  execFileSync(binaryPath, ["--version"], { timeout: 15000, stdio: "pipe", shell: isWindows });
  err({ bridge: "claude binary found", binaryPath });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  err({ bridge: "claude binary not found or not working", binaryPath, error: msg });
  out({ type: "fatal", message: `Claude Code CLI not available at "${binaryPath}". Ensure it is installed and on PATH (or set CLAUDE_CODE_BINARY_PATH). Error: ${msg}` });
  process.exit(1);
}

// Check authentication
try {
  const authOut = execFileSync(binaryPath, ["auth", "status"], { timeout: 15000, stdio: "pipe", shell: isWindows, env: process.env });
  const authStr = authOut.toString();
  err({ bridge: "auth status", output: authStr.slice(0, 300) });
  const lower = authStr.toLowerCase();
  if (lower.includes("not logged in") || lower.includes("login required") || lower.includes("authentication required")) {
    out({ type: "fatal", message: "Claude Code is not authenticated. Run `claude auth login` first." });
    process.exit(1);
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  err({ bridge: "auth check failed (may still work)", error: msg });
}

err({ bridge: "starting query", cwd, model: options.model });

const pollInterval = setInterval(() => {
  try {
    if (!existsSync(pipeFile)) return;
    const content = readFileSync(pipeFile, "utf-8").trim();
    if (!content) return;
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.cmd === "user" && typeof msg.text === "string") {
        err({ bridge: "enqueueing user message from pipe", text: msg.text.slice(0, 50) });
        enqueueUser(msg.text);
      }
    }
    writeFileSync(pipeFile, "");
  } catch (e) {
    err({ bridge: "poll error", message: e instanceof Error ? e.message : String(e) });
  }
}, 50);

let stream;
try {
  stream = query({ prompt: promptInput(), options });
  err({ bridge: "query started, polling for messages" });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  err({ bridge: "query() threw immediately", error: msg });
  out({ type: "fatal", message: `Failed to start Claude Code session: ${msg}` });
  clearInterval(pollInterval);
  process.exit(1);
}

try {
  for await (const message of stream) {
    err({ bridge: "message received", type: message.type });
    if (message.type === "stream_event") {
      const ev = message.event;
      if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
          out({ type: "text_delta", text: d.text });
        } else if (
          d.type === "thinking_delta" &&
          typeof d.thinking === "string" &&
          d.thinking.length > 0
        ) {
          out({
            type: "text_delta",
            text: d.thinking,
            meta: { streamKind: "reasoning_text" },
          });
        }
      }
    } else if (message.type === "result") {
      currentSessionId = message.session_id;
      // Fetch thread title before emitting turn_done so the adapter has it
      // before the handler exits its streamEvents() loop.
      if (currentSessionId) {
        try {
          const sessions = await listSessions({ dir: cwd, limit: 1 });
          if (sessions.length > 0 && sessions[0].summary) {
            out({ type: "thread_title", title: sessions[0].summary });
          }
        } catch {
        }
      }
      out({ type: "turn_done" });
    }
  }
} catch (e) {
  err({ bridge: "stream error", message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  out({ type: "fatal", message: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
}

clearInterval(pollInterval);

err({ bridge: "stream completed", currentSessionId });

try {
  unlinkSync(pipeFile);
} catch {
}
