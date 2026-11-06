import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import type { WordTiming } from "../edit/captions.js";

const exec = promisify(execFile);

/**
 * ElevenLabs text-to-speech, via the `/with-timestamps` endpoint.
 *
 * Why with-timestamps: it returns per-CHARACTER start/end times for the exact
 * audio it produced. Grouping those into words gives caption timings that are
 * measured, not transcribed — so captions no longer depend on the hosted
 * whisper server (which was returning 502 on 2026-11-06).
 *
 * Every synthesized clip writes a sidecar `<clip>.words.json`; the edit phase
 * (edit/build.ts → wordTimingsForBeat) prefers that sidecar over whisper.
 *
 * QUOTA: the account is on the free tier (10,000 characters / month at the
 * time of writing). A ~110 s reel is ~1,700 characters, so a re-synthesis is
 * expensive. Results are cached by a hash of everything that shapes the audio
 * (text, voice, model, neighbouring text, settings) under
 * ~/pipeline/tts-cache, and a cache hit costs nothing.
 *
 * Free-tier licence note: ElevenLabs' free plan does not include a commercial
 * licence and requires attribution. Upgrade before monetised publishing.
 */

const API = "https://api.elevenlabs.io/v1";
const CACHE_DIR = join(process.env.HOME ?? "~", "pipeline", "tts-cache", "elevenlabs");

export interface ElevenSynthesizeOptions {
  text: string;
  /** ElevenLabs voice_id. */
  voice: string;
  outPath: string;
  model?: string;
  /** 0.7–1.2 (voice_settings.speed). */
  speed?: number;
  /** The beat before / after — lets the model keep intonation continuous across beats. */
  previousText?: string;
  nextText?: string;
}

export interface ElevenClip {
  path: string;
  durationS: number;
  sampleRate: number;
  voice: string;
  model: string;
  words: WordTiming[];
  /** True when served from the local cache (no credits spent). */
  cached: boolean;
}

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Groups character timings into whitespace-delimited words. Exported for tests. */
export function wordsFromAlignment(a: Alignment): WordTiming[] {
  const words: WordTiming[] = [];
  let current: WordTiming | undefined;
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i]!;
    if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = undefined;
      continue;
    }
    const start = a.character_start_times_seconds[i]!;
    const end = a.character_end_times_seconds[i]!;
    if (!current) current = { word: ch, startS: start, endS: end };
    else {
      current.word += ch;
      current.endS = end;
    }
  }
  if (current) words.push(current);
  return words;
}

/** Path of the word-timing sidecar for a clip. */
export function wordsSidecarPath(clipPath: string): string {
  return clipPath.replace(/\.[a-z0-9]+$/i, "") + ".words.json";
}

async function probe(path: string): Promise<{ durationS: number; sampleRate: number }> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path,
  ]);
  const p = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ sample_rate?: string }>;
  };
  return {
    durationS: Number(p.format?.duration ?? 0),
    sampleRate: Number(p.streams?.[0]?.sample_rate ?? 0),
  };
}

export async function synthesizeEleven(opts: ElevenSynthesizeOptions): Promise<ElevenClip> {
  const apiKey = config.elevenlabs.apiKey;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set in .env");
  const model = opts.model ?? config.elevenlabs.model;
  const voiceSettings = {
    ...config.elevenlabs.voiceSettings,
    ...(opts.speed ? { speed: Math.min(1.2, Math.max(0.7, opts.speed)) } : {}),
  };

  const body = {
    text: opts.text,
    model_id: model,
    voice_settings: voiceSettings,
    ...(opts.previousText ? { previous_text: opts.previousText } : {}),
    ...(opts.nextText ? { next_text: opts.nextText } : {}),
  };
  const hash = createHash("sha256")
    .update(JSON.stringify({ voice: opts.voice, ...body }))
    .digest("hex")
    .slice(0, 24);
  const cachedWav = join(CACHE_DIR, `${hash}.wav`);
  const cachedWords = join(CACHE_DIR, `${hash}.words.json`);

  await mkdir(dirname(opts.outPath), { recursive: true });
  let cached = false;

  if (existsSync(cachedWav) && existsSync(cachedWords)) {
    cached = true;
  } else {
    const res = await fetch(
      `${API}/text-to-speech/${encodeURIComponent(opts.voice)}/with-timestamps?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) {
      throw new Error(
        `ElevenLabs TTS failed (${res.status}) voice="${opts.voice}" model="${model}": ${await res.text()}`,
      );
    }
    const json = (await res.json()) as { audio_base64: string; alignment: Alignment | null };
    if (!json.audio_base64) throw new Error("ElevenLabs returned no audio");
    if (!json.alignment) throw new Error("ElevenLabs returned no alignment (with-timestamps)");

    await mkdir(CACHE_DIR, { recursive: true });
    const mp3 = join(CACHE_DIR, `${hash}.mp3`);
    await writeFile(mp3, Buffer.from(json.audio_base64, "base64"));
    // The rest of the pipeline is WAV (verifiers, mixing). 44.1 kHz mono PCM.
    await exec("ffmpeg", ["-v", "error", "-y", "-i", mp3, "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", cachedWav]);
    await writeFile(cachedWords, JSON.stringify(wordsFromAlignment(json.alignment), null, 2));
  }

  await copyFile(cachedWav, opts.outPath);
  await copyFile(cachedWords, wordsSidecarPath(opts.outPath));
  const words = JSON.parse(await readFile(cachedWords, "utf8")) as WordTiming[];
  const { durationS, sampleRate } = await probe(opts.outPath);
  return { path: opts.outPath, durationS, sampleRate, voice: opts.voice, model, words, cached };
}
