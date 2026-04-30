import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export const WHISPER_SAMPLE_RATE = 16000;

let cachedFfmpegPath: string | null | undefined;

function resolveFfmpegPath(): string {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath ?? "ffmpeg";
  try {
    const require = createRequire(import.meta.url);
    const mod = require("ffmpeg-static");
    cachedFfmpegPath = (typeof mod === "string" ? mod : mod?.default) ?? null;
  } catch {
    cachedFfmpegPath = null;
  }
  return cachedFfmpegPath ?? "ffmpeg";
}

export async function decodeAudioToFloat32(
  audio: Buffer,
  sampleRate: number = WHISPER_SAMPLE_RATE,
): Promise<Float32Array> {
  const ffmpegPath = resolveFfmpegPath();
  return await new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel", "error",
        "-i", "pipe:0",
        "-f", "f32le",
        "-ac", "1",
        "-ar", String(sampleRate),
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const out: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-400)}`));
        return;
      }
      const buf = Buffer.concat(out);
      /* Copy bytes into a freshly-allocated Float32Array so the caller owns
         the memory (Buffer.concat may return a pooled SharedArrayBuffer). */
      const float32 = new Float32Array(buf.byteLength / 4);
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i < float32.length; i++) {
        float32[i] = view.getFloat32(i * 4, true);
      }
      resolve(float32);
    });

    proc.stdin.on("error", () => { /* swallow EPIPE if ffmpeg dies early */ });
    proc.stdin.end(audio);
  });
}
