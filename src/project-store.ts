import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface PersistedProject {
  channelId: string;
  createdAt: number;
}

/**
 * Simple JSON-file store that maps Discord channel IDs to PersistedProject
 * to verify that a channel was created by the bot via /project open.
 */
export class ProjectStore {
  private _path: string;
  private _data: Record<string, PersistedProject> = {};

  constructor(filePath: string) {
    this._path = filePath;
    this._load();
  }

  has(channelId: string): boolean {
    return !!this._data[channelId];
  }

  get(channelId: string): PersistedProject | undefined {
    return this._data[channelId];
  }

  set(channelId: string, entry: PersistedProject): void {
    this._data[channelId] = entry;
    this._save();
  }

  delete(channelId: string): void {
    delete this._data[channelId];
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
      console.error(`[project-store] failed to save: ${e}`);
    }
  }
}
