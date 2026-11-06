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
 * Speakers are lowercase and model-specific (see SARVAM_SPEAKERS).
 * There is no inline tag syntax on any released Bulbul model (checked docs,
 * blog and SDK 1.1.15, 2026-11-06); delivery tags in scripts are converted to
 * punctuation for Sarvam (src/tts/delivery.ts).
 */
const API = "https://api.sarvam.ai/text-to-speech";

/**
 * bulbul:v4-flash — Sarvam's newest released model (Oct 2026): 200+ personas,
 * cheaper than v3, better emotion/emphasis. Speaker ids are personas,
 * `<name>_<lang>_<style>` (e.g. "ritu_en_reels"); v3 short names are rejected.
 * The persona's STYLE is its main expression control (plus temperature).
 */
export const SARVAM_DEFAULT_MODEL = "bulbul:v4-flash";

export interface SarvamOptions {
  text: string;
  /** Speaker id, e.g. "priya". Must belong to `model`. */
  speaker: string;
  outPath: string;
  model?: string;
  /** Default en-IN (Indian English). */
  language?: string;
  /** 0.5–2.0 on v3/v4-flash. */
  pace?: number;
  /** 0.01–1.0, default 0.6 — "higher values sound more expressive" (v3/v4-flash). */
  temperature?: number;
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
  const model = opts.model ?? SARVAM_DEFAULT_MODEL;
  const res = await fetch(API, {
    method: "POST",
    headers: { "api-subscription-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: opts.text,
      language_code: opts.language ?? "en-IN",
      model,
      speaker: opts.speaker,
      speech_sample_rate: 44100,
      ...(opts.pace ? { pace: Math.min(2, Math.max(0.5, opts.pace)) } : {}),
      ...(opts.temperature ? { temperature: opts.temperature } : {}),
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

/**
 * Speakers documented on 2026-11-06. v4-flash: every en-IN persona and the
 * code-mixed enhi ones (use enhi only for genuinely mixed English–Hindi copy);
 * gender inferred from the persona name — verify by ear (`pnpm voices --sample`).
 */
export const SARVAM_SPEAKERS: Array<{ id: string; model: string; gender?: "female" | "male" }> = [
  { id: "aditi_en_stories", model: "bulbul:v4-flash", gender: "female" },
  { id: "aparna_en_companion", model: "bulbul:v4-flash", gender: "female" },
  { id: "aparna_en_edtech", model: "bulbul:v4-flash", gender: "female" },
  { id: "ashwin_en_sports", model: "bulbul:v4-flash", gender: "male" },
  { id: "ashwin_en_sports_energetic", model: "bulbul:v4-flash", gender: "male" },
  { id: "chandrika_en_stories", model: "bulbul:v4-flash", gender: "female" },
  { id: "dev_en_recovery", model: "bulbul:v4-flash", gender: "male" },
  { id: "dev_en_conversational", model: "bulbul:v4-flash", gender: "male" },
  { id: "deven_en_conversation", model: "bulbul:v4-flash", gender: "male" },
  { id: "ishita_en_customer", model: "bulbul:v4-flash", gender: "female" },
  { id: "ishita_en_medical", model: "bulbul:v4-flash", gender: "female" },
  { id: "ishita_en_numbers", model: "bulbul:v4-flash", gender: "female" },
  { id: "ishita_en_social", model: "bulbul:v4-flash", gender: "female" },
  { id: "ishita_en_stories", model: "bulbul:v4-flash", gender: "female" },
  { id: "kalpit_en_edtech", model: "bulbul:v4-flash", gender: "male" },
  { id: "nachiket_en_ads", model: "bulbul:v4-flash", gender: "male" },
  { id: "neha_en_customer", model: "bulbul:v4-flash", gender: "female" },
  { id: "neha_en_latenight", model: "bulbul:v4-flash", gender: "female" },
  { id: "nupur_en_kids", model: "bulbul:v4-flash", gender: "female" },
  { id: "ojas_en_social", model: "bulbul:v4-flash", gender: "male" },
  { id: "ritu_en_edtech", model: "bulbul:v4-flash", gender: "female" },
  { id: "ritu_en_latenight", model: "bulbul:v4-flash", gender: "female" },
  { id: "ritu_en_medical", model: "bulbul:v4-flash", gender: "female" },
  { id: "ritu_en_reels", model: "bulbul:v4-flash", gender: "female" },
  { id: "rohan_en_recovery", model: "bulbul:v4-flash", gender: "male" },
  { id: "roopa_en_conversational", model: "bulbul:v4-flash", gender: "female" },
  { id: "rustom_en_suspense", model: "bulbul:v4-flash", gender: "male" },
  { id: "sanchita_en_companion", model: "bulbul:v4-flash", gender: "female" },
  { id: "sanchita_en_insurance", model: "bulbul:v4-flash", gender: "female" },
  { id: "sanchita_en_recovery", model: "bulbul:v4-flash", gender: "female" },
  { id: "sanchita_en_market", model: "bulbul:v4-flash", gender: "female" },
  { id: "sanchita_en_social", model: "bulbul:v4-flash", gender: "female" },
  { id: "shabana_en_edtech", model: "bulbul:v4-flash", gender: "female" },
  { id: "shalini_en_companion", model: "bulbul:v4-flash", gender: "female" },
  { id: "shalini_en_customer", model: "bulbul:v4-flash", gender: "female" },
  { id: "shubh_en_narration", model: "bulbul:v4-flash", gender: "male" },
  { id: "shubh_en_numbers", model: "bulbul:v4-flash", gender: "male" },
  { id: "shubh_en_ads", model: "bulbul:v4-flash", gender: "male" },
  { id: "shubh_en_recovery", model: "bulbul:v4-flash", gender: "male" },
  { id: "shubh_en_audiobook", model: "bulbul:v4-flash", gender: "male" },
  { id: "shubh_en_narration_gentle", model: "bulbul:v4-flash", gender: "male" },
  { id: "shubh_en_sports", model: "bulbul:v4-flash", gender: "male" },
  { id: "simran_en_narration", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_en_automobile", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_en_conversation", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_en_customer", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_en_edtech", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_en_edtech_bot", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_en_sales", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_en_recovery", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_en_ads", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_en_therapist", model: "bulbul:v4-flash", gender: "female" },
  { id: "sunny_en_social", model: "bulbul:v4-flash", gender: "male" },
  { id: "varun_en_ads", model: "bulbul:v4-flash", gender: "male" },
  { id: "varun_en_suspense", model: "bulbul:v4-flash", gender: "male" },
  { id: "zarina_en_conversation", model: "bulbul:v4-flash", gender: "female" },
  { id: "amelia_en_conversational", model: "bulbul:v4-flash", gender: "female" },
  { id: "sophia_en_conversational", model: "bulbul:v4-flash", gender: "female" },
  { id: "girish_en_documentary", model: "bulbul:v4-flash", gender: "male" },
  { id: "girish_en_devotional", model: "bulbul:v4-flash", gender: "male" },
  { id: "payal_en_edtech", model: "bulbul:v4-flash", gender: "female" },
  { id: "sarang_en_narration", model: "bulbul:v4-flash", gender: "male" },
  { id: "ishita_enhi_companion", model: "bulbul:v4-flash", gender: "female" },
  { id: "ishita_enhi_customer", model: "bulbul:v4-flash", gender: "female" },
  { id: "ishita_enhi_customer_expressive", model: "bulbul:v4-flash", gender: "female" },
  { id: "sanchita_enhi_companion", model: "bulbul:v4-flash", gender: "female" },
  { id: "shalini_enhi_companion", model: "bulbul:v4-flash", gender: "female" },
  { id: "shalini_enhi_customer", model: "bulbul:v4-flash", gender: "female" },
  { id: "shubh_enhi_companion", model: "bulbul:v4-flash", gender: "male" },
  { id: "shubh_enhi_ads", model: "bulbul:v4-flash", gender: "male" },
  { id: "shubh_enhi_banking", model: "bulbul:v4-flash", gender: "male" },
  { id: "simran_enhi_companion", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_enhi_customer", model: "bulbul:v4-flash", gender: "female" },
  { id: "simran_enhi_banking_expressive", model: "bulbul:v4-flash", gender: "female" },
  { id: "sunny_enhi_customer", model: "bulbul:v4-flash", gender: "male" },
  ...["anushka", "manisha", "vidya", "arya"].map((id) => ({ id, model: "bulbul:v2", gender: "female" as const })),
  ...["abhilash", "karun", "hitesh"].map((id) => ({ id, model: "bulbul:v2", gender: "male" as const })),
];
