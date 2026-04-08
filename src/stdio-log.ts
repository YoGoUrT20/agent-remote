import { writeSync } from "node:fs";

export function logOut(line: string): void {
  writeSync(1, `${line}\n`);
}

export function logErr(line: string): void {
  writeSync(2, `${line}\n`);
}
