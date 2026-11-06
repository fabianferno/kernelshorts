import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";
import { probeMedia } from "../assets/ffprobe.js";

/**
 * Sarvam AI text-to-speech (Bulbul) — Indian-English and Indic voices.
 *
 * API (docs.sarvam.ai, read 2026-11-06):
 *   POST https://api.sarvam.ai/text-to-speech
 *   header  api-subscription-key: <key>
 *   body    { text, language_code, model, speaker, pace?, speech_sample_rate? }
 *   200     { request_id, audios: [base64 WAV] }
 * Limits: 2500 chars/request on bulbul:v3 and v4-flash (1500 on v2) — a
 * beat is far shorter. No word timestamps are returned; timings come from
 * Soniox STT (src/tts/voice.ts).
 *
 * Speakers are lowercase and model-specific: bulbul:v3 (default "shubh") has
 * e.g. priya, neha, ritu, pooja, kavya, ishita, shreya, simran…; bulbul:v2
 * has anushka/manisha/vidya/arya (female) and abhilash/karun/hitesh (male).
 */
const API = "https://api.sarvam.ai/text-to-speech";

export interface SarvamOptions {
  text: string;
  /** Speaker id, e.g. "priya". Must belong to `model`. */
  speaker: string;
  outPath: string;
  model?: string;
  /** Default en-IN (Indian English). */
  language?: string;
  pace?: number;
}

export async function synthesizeSarvam(opts: SarvamOptions): Promise<{
  path: string;
  durationS: number;
  voice: string;
  model: string;
}> {
  const key = config.sarvam.apiKey;
  if (!key) {
    throw new Error("SARVAM_API_KEY is not set in .env (sign up at sarvam.ai — new accounts get free credit).");
  }
  const model = opts.model ?? "bulbul:v3";
  const res = await fetch(API, {
    method: "POST",
    headers: { "api-subscription-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: opts.text,
      language_code: opts.language ?? "en-IN",
      model,
      speaker: opts.speaker,
      speech_sample_rate: 44100,
      ...(opts.pace ? { pace: opts.pace } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Sarvam TTS failed (${res.status}) speaker="${opts.speaker}" model="${model}": ${await res.text()}`);
  }
  const json = (await res.json()) as { audios?: string[] };
  if (!json.audios?.length) throw new Error("Sarvam returned no audio");
  const bytes = Buffer.from(json.audios.join(""), "base64");
  if (bytes.subarray(0, 4).toString() !== "RIFF") {
    throw new Error(`Sarvam returned non-WAV data (${bytes.length} bytes)`);
  }
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, bytes);
  const probe = await probeMedia(opts.outPath);
  return { path: opts.outPath, durationS: probe.durationS ?? 0, voice: opts.speaker, model };
}

/** Speakers documented on 2026-11-06 (bulbul:v4-flash adds 200+ personas; see docs). */
export const SARVAM_SPEAKERS: Array<{ id: string; model: string; gender?: "female" | "male" }> = [
  ...["anushka", "manisha", "vidya", "arya"].map((id) => ({ id, model: "bulbul:v2", gender: "female" as const })),
  ...["abhilash", "karun", "hitesh"].map((id) => ({ id, model: "bulbul:v2", gender: "male" as const })),
  ...[
    "shubh", "aditya", "ritu", "priya", "neha", "rahul", "pooja", "rohan", "simran", "kavya", "amit", "dev",
    "ishita", "shreya", "ratan", "varun", "manan", "sumit", "roopa", "kabir", "aayan", "ashutosh", "advait",
    "anand", "tanya", "tarun", "sunny", "mani", "gokul", "vijay", "shruti", "suhani", "mohit", "kavitha",
    "rehan", "soham", "rupali",
  ].map((id) => ({ id, model: "bulbul:v3" })),
];
