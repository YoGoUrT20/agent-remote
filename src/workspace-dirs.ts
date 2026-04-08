import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Settings } from "./config.js";

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".cache",
  "dist",
  "build",
  ".next",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
]);

export const WORKSPACE_SELECT_MAX_OPTIONS = 25;

export function workspaceRootPath(settings: Settings): string {
  const p = (settings.claudeWorkspaceCwd ?? "").trim();
  return p ? resolve(p) : resolve(process.cwd());
}

export function listWorkspaceSubfolders(settings: Settings): string[] {
  const root = workspaceRootPath(settings);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (SKIP_DIR_NAMES.has(ent.name)) continue;
    out.push(ent.name);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function normSlugSegment(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function findExistingWorkspaceFolder(
  settings: Settings,
  channelSlug: string,
  rawLabel: string,
): string | null {
  const root = workspaceRootPath(settings);
  if (!existsSync(root)) return null;
  const direct = join(root, channelSlug);
  try {
    if (existsSync(direct) && statSync(direct).isDirectory()) return channelSlug;
  } catch {
  }
  const raw = rawLabel.trim();
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || SKIP_DIR_NAMES.has(ent.name)) continue;
    if (ent.name === raw) return ent.name;
    if (ent.name.toLowerCase() === channelSlug.toLowerCase()) return ent.name;
    if (normSlugSegment(ent.name) === channelSlug) return ent.name;
  }
  return null;
}

export function projectFolderPath(settings: Settings, dirName: string): string {
  return join(workspaceRootPath(settings), dirName);
}
