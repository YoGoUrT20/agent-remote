import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

export type WhisperDType = "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16";

export interface WhisperConfig {
  modelId: string;
  dtype: WhisperDType;
  language: string | null;
}

export const DEFAULT_WHISPER_CONFIG: WhisperConfig = {
  modelId: "onnx-community/whisper-base",
  dtype: "q8",
  language: null,
};

let cached: { key: string; pipe: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

function configKey(cfg: WhisperConfig): string {
  return `${cfg.modelId}::${cfg.dtype}`;
}

async function loadPipeline(cfg: WhisperConfig): Promise<AutomaticSpeechRecognitionPipeline> {
  const key = configKey(cfg);
  if (cached && cached.key === key) return cached.pipe;
  const { pipeline } = await import("@huggingface/transformers");
  const pipe = pipeline("automatic-speech-recognition", cfg.modelId, {
    dtype: cfg.dtype,
  }) as Promise<AutomaticSpeechRecognitionPipeline>;
  cached = { key, pipe };
  return pipe;
}

/** Pre-warm the model so the first voice message doesn't pay the load cost. */
export async function warmupWhisper(cfg: WhisperConfig = DEFAULT_WHISPER_CONFIG): Promise<void> {
  await loadPipeline(cfg);
}

export interface TranscriptionResult {
  text: string;
}

export async function transcribeFloat32(
  audio: Float32Array,
  cfg: WhisperConfig = DEFAULT_WHISPER_CONFIG,
): Promise<TranscriptionResult> {
  const transcriber = await loadPipeline(cfg);
  const out = await transcriber(audio, {
    task: "transcribe",
    language: cfg.language ?? null,
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  } as Record<string, unknown>);
  const text = Array.isArray(out)
    ? (out[0]?.text ?? "")
    : ((out as { text?: string }).text ?? "");
  return { text: text.trim() };
}
