export function sanitizeDiscordCredential(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\r|\n/g, "");
}
