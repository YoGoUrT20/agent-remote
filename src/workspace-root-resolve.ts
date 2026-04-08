import { resolve } from "node:path";

export function resolveWorkspaceRootForRuntime(rawFromEnv: string): string {
  const base = (rawFromEnv ?? "").trim();
  if (!base) {
    return resolve(process.cwd());
  }
  return resolve(base);
}
