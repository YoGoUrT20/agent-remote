import type { Settings } from "../config.js";
import { ClaudeAgentSdkAdapter } from "./claude.js";
import { CodexCliAdapter } from "./codex.js";
import { OpenCodeCliAdapter } from "./opencode.js";
import { BaseAdapter } from "./base.js";

export function buildChatAdapter(providerKey: string, settings: Settings): BaseAdapter {
  if (providerKey === "claude") {
    return new ClaudeAgentSdkAdapter(settings);
  }
  if (providerKey === "codex") {
    return new CodexCliAdapter(settings);
  }
  if (providerKey === "opencode") {
    return new OpenCodeCliAdapter(settings);
  }
  throw new Error(`Chat is not implemented for provider '${providerKey}'`);
}
