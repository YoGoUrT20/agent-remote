import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AccessOverrides {
  ownerUserId?: string;
  allowedUserIds?: string[];
  restrictToWhitelist?: boolean;
  pingOnResponse?: boolean;
}

/**
 * JSON-backed overrides for access-control settings. Values set here win
 * over the corresponding env vars, so the /settings command can adjust
 * behavior at runtime without editing .env.
 *
 * Absent fields fall back to env (see config.ts).
 */
export class AccessStore {
  private _path: string;
  private _data: AccessOverrides = {};

  constructor(filePath: string) {
    this._path = filePath;
    this._load();
  }

  all(): AccessOverrides {
    return { ...this._data, allowedUserIds: [...(this._data.allowedUserIds ?? [])] };
  }

  setOwner(userId: string | null): void {
    if (userId) this._data.ownerUserId = userId;
    else delete this._data.ownerUserId;
    this._save();
  }

  setRestrictToWhitelist(on: boolean | null): void {
    if (on === null) delete this._data.restrictToWhitelist;
    else this._data.restrictToWhitelist = on;
    this._save();
  }

  addAllowed(userIds: string[]): number {
    const current = new Set(this._data.allowedUserIds ?? []);
    let added = 0;
    for (const id of userIds) {
      if (!id) continue;
      if (!current.has(id)) {
        current.add(id);
        added++;
      }
    }
    this._data.allowedUserIds = [...current];
    this._save();
    return added;
  }

  removeAllowed(userIds: string[]): number {
    const current = new Set(this._data.allowedUserIds ?? []);
    let removed = 0;
    for (const id of userIds) {
      if (current.delete(id)) removed++;
    }
    this._data.allowedUserIds = [...current];
    this._save();
    return removed;
  }

  clearAllowed(): void {
    this._data.allowedUserIds = [];
    this._save();
  }

  setPingOnResponse(on: boolean | null): void {
    if (on === null) delete this._data.pingOnResponse;
    else this._data.pingOnResponse = on;
    this._save();
  }

  private _load(): void {
    try {
      const raw = readFileSync(this._path, "utf-8");
      const parsed = JSON.parse(raw) as AccessOverrides;
      this._data = {
        ownerUserId: typeof parsed.ownerUserId === "string" ? parsed.ownerUserId : undefined,
        allowedUserIds: Array.isArray(parsed.allowedUserIds)
          ? parsed.allowedUserIds.filter((x): x is string => typeof x === "string")
          : undefined,
        restrictToWhitelist:
          typeof parsed.restrictToWhitelist === "boolean" ? parsed.restrictToWhitelist : undefined,
        pingOnResponse:
          typeof parsed.pingOnResponse === "boolean" ? parsed.pingOnResponse : undefined,
      };
    } catch {
      this._data = {};
    }
  }

  private _save(): void {
    try {
      mkdirSync(dirname(this._path), { recursive: true });
      writeFileSync(this._path, JSON.stringify(this._data, null, 2), "utf-8");
    } catch (e) {
      console.error(`[access-store] failed to save: ${e}`);
    }
  }
}

export function defaultAccessStorePath(): string {
  return join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".agent-remote",
    "access.json",
  );
}

export interface EffectiveAccess {
  ownerUserId: string;
  allowedUserIds: string[];
  restrictToWhitelist: boolean;
  pingOnResponse: boolean;
}

export interface AccessEnvDefaults {
  ownerUserId: string;
  allowedUserIds: string[];
  restrictToWhitelist: boolean;
}

/**
 * Merge env defaults with runtime overrides. Runtime overrides, when present,
 * win over env. The owner is always implicitly allowed.
 */
export function effectiveAccess(
  env: AccessEnvDefaults,
  overrides: AccessOverrides,
): EffectiveAccess {
  const ownerUserId = overrides.ownerUserId ?? env.ownerUserId ?? "";
  const listSource =
    overrides.allowedUserIds !== undefined ? overrides.allowedUserIds : env.allowedUserIds;
  const dedup = new Set<string>();
  for (const id of listSource) if (id) dedup.add(id);
  if (ownerUserId) dedup.add(ownerUserId);
  const restrictToWhitelist =
    overrides.restrictToWhitelist !== undefined
      ? overrides.restrictToWhitelist
      : env.restrictToWhitelist;
  const pingOnResponse = overrides.pingOnResponse ?? false;
  return {
    ownerUserId,
    allowedUserIds: [...dedup],
    restrictToWhitelist,
    pingOnResponse,
  };
}

export function isUserAllowed(userId: string, access: EffectiveAccess): boolean {
  if (!access.restrictToWhitelist) return true;
  if (!userId) return false;
  if (access.ownerUserId && userId === access.ownerUserId) return true;
  return access.allowedUserIds.includes(userId);
}
