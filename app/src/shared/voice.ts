/**
 * Voice input (local Whisper) wire types shared across main, preload, and
 * renderer. The engine seam itself is `main/voice.ts`; these are the shapes
 * that cross IPC plus the model-size vocabulary both sides validate against.
 */

/** ggml model sizes Cascade ships/downloads for whisper.cpp. The English-only
 *  `.en` variants are smaller and faster, which is the chat dictation use case. */
export type WhisperModel = "tiny.en" | "base.en" | "small.en";

/** Selectable model sizes, cheapest/fastest first. */
export const WHISPER_MODELS: readonly WhisperModel[] = ["tiny.en", "base.en", "small.en"];

/** Default model: a good speed/accuracy balance for dictation. */
export const DEFAULT_WHISPER_MODEL: WhisperModel = "base.en";

export function isWhisperModel(v: unknown): v is WhisperModel {
  return typeof v === "string" && (WHISPER_MODELS as readonly string[]).includes(v);
}

/** Resolve a stored model string to a valid size, falling back to the default. */
export function coerceWhisperModel(v: unknown): WhisperModel {
  return isWhisperModel(v) ? v : DEFAULT_WHISPER_MODEL;
}

/** Voice input status: whether the CLI is present and the model is downloaded. */
export interface VoiceStatusIpc {
  /** The whisper.cpp CLI binary was found (bundled or on PATH). */
  available: boolean;
  /** Resolved binary path, for diagnostics (null when not found). */
  binary: string | null;
  /** Currently selected model size. */
  model: WhisperModel;
  /** The selected ggml model file is downloaded and ready. */
  modelReady: boolean;
  /** A model download is currently in progress. */
  downloading: boolean;
}

/** Progress emitted while the ggml model downloads on first use. */
export interface VoiceProgressIpc {
  model: WhisperModel;
  /** Bytes received so far. */
  received: number;
  /** Total bytes, or 0 when the server did not send a content-length. */
  total: number;
}
