import type { Database } from "bun:sqlite";

export interface PersistedSession {
  sessionId: string;
  cwd: string;
  providerKey: string;
  /** Last model used for this session (persisted so /model survives restarts). */
  model?: string;
}

/**
 * SQLite-backed store that maps Discord thread IDs to agent session metadata
 * so conversations survive bot restarts.
 */
export class SessionStore {
  private _db: Database;

  constructor(db: Database) {
    this._db = db;
  }

  get(threadId: string): PersistedSession | undefined {
    const row = this._db
      .query<
        { session_id: string; cwd: string; provider_key: string; model: string | null },
        [string]
      >("SELECT session_id, cwd, provider_key, model FROM sessions WHERE thread_id = ?")
      .get(threadId);
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      cwd: row.cwd,
      providerKey: row.provider_key,
      model: row.model ?? undefined,
    };
  }

  set(threadId: string, entry: PersistedSession): void {
    this._db
      .query(
        `INSERT INTO sessions (thread_id, session_id, cwd, provider_key, model)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           session_id   = excluded.session_id,
           cwd          = excluded.cwd,
           provider_key = excluded.provider_key,
           model        = excluded.model`,
      )
      .run(threadId, entry.sessionId, entry.cwd, entry.providerKey, entry.model ?? null);
  }

  delete(threadId: string): void {
    this._db.query("DELETE FROM sessions WHERE thread_id = ?").run(threadId);
  }
}
