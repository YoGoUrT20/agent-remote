import type { Attachment, Message } from "discord.js";
import { isVoiceAttachment } from "./voice/index.js";
import { warn as logWarn } from "./logger.js";

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml"];

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

export interface DownloadedAttachment {
  type: "image" | "text";
  mimeType: string;
  data: string; // base64 for images, raw text for text files
  fileName: string;
}

function isImageMime(mime: string): boolean {
  return IMAGE_MIME_TYPES.has(mime);
}

function isTextMime(mime: string): boolean {
  return TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

function guessMimeType(att: Attachment): string {
  if (att.contentType) return att.contentType.split(";")[0].trim().toLowerCase();
  const name = (att.name ?? "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".xml")) return "application/xml";
  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".csv")) return "text/plain";
  if (name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".py") || name.endsWith(".rs")
    || name.endsWith(".go") || name.endsWith(".java") || name.endsWith(".c") || name.endsWith(".cpp")
    || name.endsWith(".h") || name.endsWith(".hpp") || name.endsWith(".rb") || name.endsWith(".sh")
    || name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".toml") || name.endsWith(".sql")
    || name.endsWith(".html") || name.endsWith(".css") || name.endsWith(".jsx") || name.endsWith(".tsx")
    || name.endsWith(".svelte") || name.endsWith(".vue")) return "text/plain";
  return "application/octet-stream";
}

export function pickNonVoiceAttachments(message: Message): Attachment[] {
  const result: Attachment[] = [];
  for (const att of message.attachments.values()) {
    if (isVoiceAttachment(att)) continue;
    if (att.size > MAX_FILE_SIZE) continue;
    const mime = guessMimeType(att);
    if (isImageMime(mime) || isTextMime(mime)) {
      result.push(att);
    }
  }
  return result;
}

export async function downloadAttachment(att: Attachment): Promise<DownloadedAttachment> {
  const mime = guessMimeType(att);
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`Failed to download attachment ${att.name}: HTTP ${res.status}`);

  if (isImageMime(mime)) {
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      type: "image",
      mimeType: mime,
      data: buf.toString("base64"),
      fileName: att.name ?? "image",
    };
  }

  const text = await res.text();
  return {
    type: "text",
    mimeType: mime,
    data: text,
    fileName: att.name ?? "file",
  };
}

export async function downloadAllAttachments(message: Message): Promise<DownloadedAttachment[]> {
  const attachments = pickNonVoiceAttachments(message);
  if (attachments.length === 0) return [];
  const results = await Promise.allSettled(
    attachments.map((att) => downloadAttachment(att)),
  );
  const downloaded: DownloadedAttachment[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      downloaded.push(r.value);
    } else {
      logWarn(`[attachments] download failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  }
  return downloaded;
}
