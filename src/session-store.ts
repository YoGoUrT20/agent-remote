import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface PersistedSession {
  sessionId: string;
  cwd: string;
  providerKey: string;
  /** Last model used for this session (persisted so /model survives restarts). */
  model?: string;
}

/**
 * Simple JSON-file store that maps Discord thread IDs to Claude session IDs
 * so conversations survive bot restarts.
 */
export class SessionStore {
  private _path: string;
  private _data: Record<string, PersistedSession> = {};

  constructor(filePath: string) {
    this._path = filePath;
    this._load();
  }

  get(threadId: string): PersistedSession | undefined {
    return this._data[threadId];
  }

  set(threadId: string, entry: PersistedSession): void {
    this._data[threadId] = entry;
    this._save();
  }

  delete(threadId: string): void {
    delete this._data[threadId];
    this._save();
  }

  private _load(): void {
    try {
      const raw = readFileSync(this._path, "utf-8");
      this._data = JSON.parse(raw);
    } catch {
      this._data = {};
    }
  }

  private _save(): void {
    try {
      mkdirSync(dirname(this._path), { recursive: true });
      writeFileSync(this._path, JSON.stringify(this._data, null, 2), "utf-8");
    } catch (e) {
      console.error(`[session-store] failed to save: ${e}`);
    }
  }
}
