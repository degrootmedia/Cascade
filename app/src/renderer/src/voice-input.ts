/**
 * Microphone capture + live Whisper transcription for the chat composer.
 *
 * Captures 16 kHz mono (the AudioContext resamples the mic stream), accumulates
 * Int16 PCM, and on a rolling interval sends the whole utterance to
 * `voice:transcribe` for an interim transcript. Only one transcription runs at
 * a time (a tick while busy is skipped) and only the newest result is applied,
 * so a slow model can't queue up work. Stopping transcribes the buffer once
 * more and hands the final text to `onFinal`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const SAMPLE_RATE = 16000;
/** How often to refresh the interim transcript while recording. */
const TICK_MS = 1500;
/** Auto-stop past this many seconds so a runaway recording can't grow forever. */
const MAX_RECORD_SEC = 120;

export interface VoiceInput {
  recording: boolean;
  /** Full transcript of the utterance so far (empty before the first result). */
  interim: string;
  /** Preparing the engine/model (first-use download or mic permission). */
  preparing: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
}

interface VoiceRefs {
  stream: MediaStream | null;
  ctx: AudioContext | null;
  node: ScriptProcessorNode | null;
  source: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  chunks: Int16Array[];
  total: number;
  timer: number | null;
  busy: boolean;
  active: boolean;
}

export function useVoiceInput(onFinal: (transcript: string) => void): VoiceInput {
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ref = useRef<VoiceRefs>({
    stream: null,
    ctx: null,
    node: null,
    source: null,
    gain: null,
    chunks: [],
    total: 0,
    timer: null,
    busy: false,
    active: false,
  });
  const finalRef = useRef(onFinal);
  finalRef.current = onFinal;

  /** Transcribe the accumulated buffer (empty string when nothing captured). */
  const transcribeNow = useCallback(async (): Promise<string> => {
    const s = ref.current;
    if (!s.total) return "";
    const pcm = new Int16Array(s.total);
    let off = 0;
    for (const c of s.chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    const { text } = await window.cascade.transcribeVoice(pcm.buffer as ArrayBuffer, SAMPLE_RATE);
    return text;
  }, []);

  const stop = useCallback(() => {
    const s = ref.current;
    if (!s.active) return;
    s.active = false;
    setRecording(false);
    if (s.timer !== null) {
      clearInterval(s.timer);
      s.timer = null;
    }
    if (s.node) s.node.onaudioprocess = null;
    try { s.source?.disconnect(); } catch { /* ignore */ }
    try { s.node?.disconnect(); } catch { /* ignore */ }
    try { s.gain?.disconnect(); } catch { /* ignore */ }
    s.stream?.getTracks().forEach((t) => t.stop());
    void s.ctx?.close().catch(() => {});
    s.stream = null;
    s.ctx = null;
    s.node = null;
    s.source = null;
    s.gain = null;
    // The final, authoritative transcription.
    void transcribeNow()
      .then((text) => {
        if (text) finalRef.current(text);
        setInterim("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [transcribeNow]);

  const start = useCallback(async () => {
    const s = ref.current;
    if (s.active) return;
    setError(null);
    setPreparing(true);
    try {
      const status = await window.cascade.prepareVoice();
      if (!status.available) throw new Error("Voice input is unavailable — the speech engine was not found.");
      if (!status.modelReady) throw new Error("The speech model could not be prepared.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const gain = ctx.createGain();
      gain.gain.value = 0; // keep the graph pulling without echoing to speakers
      node.onaudioprocess = (e) => {
        const frame = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(frame.length);
        for (let i = 0; i < frame.length; i++) {
          const v = Math.max(-1, Math.min(1, frame[i]));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        s.chunks.push(pcm);
        s.total += pcm.length;
        if (s.total > SAMPLE_RATE * MAX_RECORD_SEC) stop();
      };
      source.connect(node);
      node.connect(gain);
      gain.connect(ctx.destination);
      s.stream = stream;
      s.ctx = ctx;
      s.source = source;
      s.node = node;
      s.gain = gain;
      s.chunks = [];
      s.total = 0;
      s.busy = false;
      s.active = true;
      setInterim("");
      setRecording(true);
      s.timer = window.setInterval(() => {
        if (!s.active || s.busy || !s.total) return;
        s.busy = true;
        void transcribeNow()
          .then((text) => {
            if (s.active) setInterim(text);
          })
          .catch(() => { /* keep the last interim; the final pass will report */ })
          .finally(() => {
            s.busy = false;
          });
      }, TICK_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      stop();
    } finally {
      setPreparing(false);
    }
  }, [stop, transcribeNow]);

  // Release the mic if the composer unmounts mid-recording.
  useEffect(() => () => stop(), [stop]);

  return { recording, interim, preparing, error, start, stop };
}
