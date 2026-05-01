import { writeSync } from "node:fs";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function parseLevel(raw: string | undefined): number {
  const key = raw?.toLowerCase().trim() as Level | undefined;
  return key && key in LEVELS ? LEVELS[key] : LEVELS.info;
}

let _minLevel = parseLevel(process.env.LOG_LEVEL);

/** Override the minimum log level at runtime (useful for tests). */
export function setLogLevel(level: Level): void {
  _minLevel = LEVELS[level];
}

const LABELS: Record<Level, string> = {
  debug: "DEBUG",
  info:  "INFO ",
  warn:  "WARN ",
  error: "ERROR",
};

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(level: Level, msg: string): void {
  if (LEVELS[level] < _minLevel) return;
  writeSync(2, `${timestamp()}  ${LABELS[level]}  ${msg}\n`);
}

export function debug(msg: string): void { log("debug", msg); }
export function info(msg:  string): void { log("info",  msg); }
export function warn(msg:  string): void { log("warn",  msg); }
export function error(msg: string): void { log("error", msg); }

export function print(msg: string): void {
  writeSync(1, `${msg}\n`);
}
