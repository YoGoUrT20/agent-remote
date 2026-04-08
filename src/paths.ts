import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function bridgeScriptPath(): string {
  return join(repoRoot(), "claude_agent_bridge", "bridge.mjs");
}
