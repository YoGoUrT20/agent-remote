import type { Database } from "bun:sqlite";

export interface PersistedProject {
  channelId: string;
  createdAt: number;
}

/**
 * SQLite-backed store that maps Discord channel IDs to PersistedProject
 * to verify that a channel was created by the bot via /project open.
 */
export class ProjectStore {
  private _db: Database;

  constructor(db: Database) {
    this._db = db;
  }

  has(channelId: string): boolean {
    const row = this._db
      .query<{ channel_id: string }, [string]>(
        "SELECT channel_id FROM projects WHERE channel_id = ?",
      )
      .get(channelId);
    return !!row;
  }

  get(channelId: string): PersistedProject | undefined {
    const row = this._db
      .query<{ channel_id: string; created_at: number }, [string]>(
        "SELECT channel_id, created_at FROM projects WHERE channel_id = ?",
      )
      .get(channelId);
    if (!row) return undefined;
    return { channelId: row.channel_id, createdAt: row.created_at };
  }

  set(channelId: string, entry: PersistedProject): void {
    this._db
      .query(
        `INSERT INTO projects (channel_id, created_at) VALUES (?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET created_at = excluded.created_at`,
      )
      .run(channelId, entry.createdAt);
  }

  delete(channelId: string): void {
    this._db.query("DELETE FROM projects WHERE channel_id = ?").run(channelId);
  }
}
