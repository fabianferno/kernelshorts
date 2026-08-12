import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const exec = promisify(execFile);

/**
 * Soniox text-to-speech.
 *
 * Endpoint quirks, all confirmed against the live API on 2026-08-12:
 *  - TTS lives on `tts-rt.soniox.com`, NOT the `api.soniox.com` host used for
 *    STT. `api.soniox.com/v1/tts` 404s, and `/v1/models` lists only stt-* models,
 *    so neither is evidence that TTS is unavailable.
 *  - Voice listing IS on api.soniox.com (`GET /v1/voices`).
 *  - Cloned voices must be referenced by UUID. Passing the display name returns
 *    400 "Invalid voice". Built-in voices (e.g. "Adrian") are referenced by name.
 *  - A cloned voice is only usable on a model where /v1/voices reports
 *    status "ready"; others return 409 "not been prepared for the requested
 *    model". We resolve the model from that status rather than assuming latest.
 *  - The response body is raw audio bytes, served as application/octet-stream.
 */

const TTS_URL = "https://tts-rt.soniox.com/tts";
const VOICES_URL = "https://api.soniox.com/v1/voices";

export interface SonioxVoice {
  id: string;
  name: string;
  models: Array<{ model: string; status: string }>;
}

export async function listVoices(): Promise<SonioxVoice[]> {
  const res = await fetch(VOICES_URL, {
    headers: { Authorization: `Bearer ${config.soniox.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Soniox listVoices failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { voices: SonioxVoice[] }).voices;
}

/**
 * Resolves a voice the user named (either a clone's display name or a built-in
 * voice) into the {voice, model} pair the API will actually accept.
 * Throws if the clone exists but is not ready on any model — that is a real
 * blocker to surface, not something to silently fall back from.
 */
export async function resolveVoice(
  requested: string,
  preferredModel = "tts-rt-v2",
): Promise<{ voice: string; model: string }> {
  const clone = (await listVoices()).find(
    (v) => v.name.toLowerCase() === requested.toLowerCase() || v.id === requested,
  );
  if (!clone) {
    // Not a clone on this account — treat as a built-in voice name.
    return { voice: requested, model: preferredModel };
  }
  const ready = clone.models.filter((m) => m.status === "ready").map((m) => m.model);
  if (ready.length === 0) {
    throw new Error(
      `Soniox voice "${clone.name}" (${clone.id}) is not ready on any model ` +
        `(states: ${clone.models.map((m) => `${m.model}=${m.status}`).join(", ")}). ` +
        `Recompute the voice in the Soniox console before using it.`,
    );
  }
  return {
    voice: clone.id,
    model: ready.includes(preferredModel) ? preferredModel : ready[0]!,
  };
}

export interface SynthesizeOptions {
  text: string;
  /** Clone display name / UUID, or a built-in voice name like "Adrian". */
  voice: string;
  outPath: string;
  language?: string;
  model?: string;
}

export interface SynthesizedClip {
  path: string;
  durationS: number;
  sampleRate: number;
  voice: string;
  model: string;
}

/**
 * Synthesizes one beat's voiceover to a real WAV on disk and measures its real
 * duration with ffprobe. The measured duration is what drives beat timing —
 * the pipeline is audio-first (PRD §3.7), so nothing downstream may estimate
 * duration from word counts.
 */
export async function synthesize(opts: SynthesizeOptions): Promise<SynthesizedClip> {
  const { voice, model } = opts.model
    ? { voice: opts.voice, model: opts.model }
    : await resolveVoice(opts.voice);

  const res = await fetch(TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.soniox.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      language: opts.language ?? "en",
      voice,
      audio_format: "wav",
      text: opts.text,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Soniox TTS failed (${res.status}) for voice="${voice}" model="${model}": ` +
        `${await res.text()}`,
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.subarray(0, 4).toString() !== "RIFF") {
    throw new Error(`Soniox returned non-WAV data (${bytes.length} bytes)`);
  }
  await writeFile(opts.outPath, bytes);

  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", opts.outPath,
  ]);
  const probe = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ sample_rate?: string }>;
  };

  return {
    path: opts.outPath,
    durationS: Number(probe.format?.duration ?? 0),
    sampleRate: Number(probe.streams?.[0]?.sample_rate ?? 0),
    voice,
    model,
  };
}
