import { type Attachment, type Message, MessageFlags } from "discord.js";
import { decodeAudioToFloat32, WHISPER_SAMPLE_RATE } from "./decode.js";
import {
  DEFAULT_WHISPER_CONFIG,
  transcribeFloat32,
  warmupWhisper,
  type WhisperConfig,
} from "./transcribe.js";

export { DEFAULT_WHISPER_CONFIG, warmupWhisper };
export type { WhisperConfig };

export function isVoiceMessage(message: Message): boolean {
  if (message.flags?.has?.(MessageFlags.IsVoiceMessage)) return true;
  return message.attachments.some((a) => isVoiceAttachment(a));
}

export function isVoiceAttachment(att: Attachment): boolean {
  if (typeof att.duration === "number" && typeof att.waveform === "string") return true;
  if (typeof att.duration === "number" && (att.contentType?.startsWith("audio/") ?? false)) return true;
  return false;
}

export function pickVoiceAttachment(message: Message): Attachment | null {
  for (const att of message.attachments.values()) {
    if (isVoiceAttachment(att)) return att;
  }
  if (message.flags?.has?.(MessageFlags.IsVoiceMessage)) {
    for (const att of message.attachments.values()) {
      if (att.contentType?.startsWith("audio/")) return att;
    }
  }
  return null;
}

export interface VoiceTranscription {
  text: string;
  durationSeconds: number;
}

export async function transcribeVoiceAttachment(
  att: Attachment,
  config: WhisperConfig = DEFAULT_WHISPER_CONFIG,
): Promise<VoiceTranscription> {
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const audio = await decodeAudioToFloat32(buf);
  const durationSeconds =
    typeof att.duration === "number" && att.duration > 0
      ? att.duration
      : audio.length / WHISPER_SAMPLE_RATE;
  const { text } = await transcribeFloat32(audio, config);
  return { text, durationSeconds };
}
