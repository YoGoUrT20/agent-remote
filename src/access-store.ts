import type { Database } from "bun:sqlite";
import { join } from "node:path";

export interface AccessOverrides {
  ownerUserId?: string;
  allowedUserIds?: string[];
  restrictToWhitelist?: boolean;
  pingOnResponse?: boolean;
}

export class AccessStore {
  private _db: Database;

  constructor(db: Database) {
    this._db = db;
  }

  all(): AccessOverrides {
    const rows = this._db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM access")
      .all();
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      ownerUserId: map["owner_user_id"] ?? undefined,
      allowedUserIds: map["allowed_user_ids"] ? JSON.parse(map["allowed_user_ids"]) : undefined,
      restrictToWhitelist:
        map["restrict_to_whitelist"] !== undefined
          ? map["restrict_to_whitelist"] === "true"
          : undefined,
      pingOnResponse:
        map["ping_on_response"] !== undefined ? map["ping_on_response"] === "true" : undefined,
    };
  }

  setOwner(userId: string | null): void {
    if (userId) {
      this._upsert("owner_user_id", userId);
    } else {
      this._delete("owner_user_id");
    }
  }

  setRestrictToWhitelist(on: boolean | null): void {
    if (on === null) this._delete("restrict_to_whitelist");
    else this._upsert("restrict_to_whitelist", String(on));
  }

  addAllowed(userIds: string[]): number {
    const current = new Set<string>(this._getAllowedIds());
    let added = 0;
    for (const id of userIds) {
      if (!id) continue;
      if (!current.has(id)) {
        current.add(id);
        added++;
      }
    }
    this._upsert("allowed_user_ids", JSON.stringify([...current]));
    return added;
  }

  removeAllowed(userIds: string[]): number {
    const current = new Set<string>(this._getAllowedIds());
    let removed = 0;
    for (const id of userIds) {
      if (current.delete(id)) removed++;
    }
    this._upsert("allowed_user_ids", JSON.stringify([...current]));
    return removed;
  }

  clearAllowed(): void {
    this._upsert("allowed_user_ids", JSON.stringify([]));
  }

  setPingOnResponse(on: boolean | null): void {
    if (on === null) this._delete("ping_on_response");
    else this._upsert("ping_on_response", String(on));
  }

  private _getAllowedIds(): string[] {
    const row = this._db
      .query<{ value: string }, [string]>("SELECT value FROM access WHERE key = ?")
      .get("allowed_user_ids");
    if (!row) return [];
    try {
      return JSON.parse(row.value);
    } catch {
      return [];
    }
  }

  private _upsert(key: string, value: string): void {
    this._db
      .query(
        `INSERT INTO access (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private _delete(key: string): void {
    this._db.query("DELETE FROM access WHERE key = ?").run(key);
  }
}

export function defaultAccessStorePath(): string {
  return join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".agent-remote",
    "agent-remote.db",
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
