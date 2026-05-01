import type { Database } from "bun:sqlite";
import { join } from "node:path";

export interface ModelOverrides {
  /** Default model per provider key (e.g. { claude: "claude-opus-4-5-20250929" }). */
  defaultModels?: Record<string, string>;
}

/**
 * SQLite-backed store for model configuration set via /settings.
 * Values here override the env-based defaults from config.ts.
 */
export class ModelStore {
  private _db: Database;

  constructor(db: Database) {
    this._db = db;
  }

  all(): ModelOverrides {
    const rows = this._db
      .query<{ provider_key: string; model: string }, []>(
        "SELECT provider_key, model FROM model_defaults",
      )
      .all();
    return {
      defaultModels: Object.fromEntries(rows.map((r) => [r.provider_key, r.model])),
    };
  }

  getDefaultModel(providerKey: string): string | undefined {
    const row = this._db
      .query<{ model: string }, [string]>(
        "SELECT model FROM model_defaults WHERE provider_key = ?",
      )
      .get(providerKey);
    return row?.model;
  }

  setDefaultModel(providerKey: string, model: string | null): void {
    if (model) {
      this._db
        .query(
          `INSERT INTO model_defaults (provider_key, model) VALUES (?, ?)
           ON CONFLICT(provider_key) DO UPDATE SET model = excluded.model`,
        )
        .run(providerKey, model);
    } else {
      this._db.query("DELETE FROM model_defaults WHERE provider_key = ?").run(providerKey);
    }
  }
}

export function defaultModelStorePath(): string {
  return join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".agent-remote",
    "agent-remote.db",
  );
}
