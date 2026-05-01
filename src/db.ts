import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function defaultDbPath(): string {
  return join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".agent-remote",
    "agent-remote.db",
  );
}

export function openDb(dbPath: string = defaultDbPath()): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      thread_id    TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      cwd          TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      model        TEXT
    );
    CREATE TABLE IF NOT EXISTS access (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_defaults (
      provider_key TEXT PRIMARY KEY,
      model        TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      channel_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}
