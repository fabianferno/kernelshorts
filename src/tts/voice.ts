import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { synthesizeEleven, wordsSidecarPath } from "./elevenlabs.js";
import { synthesize as synthesizeSoniox } from "./soniox.js";
import { synthesizeSarvam } from "./sarvam.js";
import { transcribeFile } from "../verify/timeline.js";
import { probeMedia } from "../assets/ffprobe.js";
import type { WordTiming } from "../edit/captions.js";

/**
 * One voice API over several TTS providers, chosen per character
 * (vault/characters/<id>/character.json → "voice").
 *
 *   elevenlabs  word timings come back with the audio (with-timestamps)
 *   soniox      e.g. the user's own cloned voice; timings via Soniox STT
 *   sarvam      Indian-English / Indic voices (Bulbul); timings via Soniox STT
 *
 * Every clip lands as <outPath>.wav plus a <outPath>.words.json sidecar, which
 * is what the edit reads for captions and the host's mouth — so the rest of
 * the pipeline never knows which provider spoke.
 */
export const VoiceSpec = z.object({
  provider: z.enum(["elevenlabs", "soniox", "sarvam"]),
  /** ElevenLabs voice_id · Soniox voice name/clone UUID · Sarvam speaker id. */
  voiceId: z.string().min(1),
  /** Provider model (ElevenLabs model_id · Soniox tts-rt-v2 · Sarvam bulbul:v3). */
  model: z.string().optional(),
  /** Sarvam language_code (default en-IN); Soniox language (default en). */
  language: z.string().optional(),
  /** Speaking rate: Sarvam pace 0.5–2 · Soniox speed 0.7–1.3 · ElevenLabs speed 0.7–1.2. */
  speed: z.number().min(0.5).max(2).optional(),
  /** Sarvam only: expressiveness 0.01–1 (default 0.6; higher = livelier, more artifacts). */
  temperature: z.number().min(0.01).max(1).optional(),
  label: z.string().optional(),
});
export type VoiceSpec = z.infer<typeof VoiceSpec>;

export interface VoiceClip {
  path: string;
  durationS: number;
  voice: string;
  model: string;
  words: WordTiming[];
  cached: boolean;
}

/**
 * Parses a `--voice` override: "provider:id" switches provider, a bare id keeps
 * the character's provider.
 */
export function parseVoiceOverride(override: string | undefined, base: VoiceSpec): VoiceSpec {
  if (!override) return base;
  const m = override.match(/^(elevenlabs|soniox|sarvam):(.+)$/);
  if (m) return { provider: m[1] as VoiceSpec["provider"], voiceId: m[2]! };
  return { ...base, voiceId: override, label: undefined };
}

/** Soniox STT tokens → words. A token that starts with a space begins a new word. */
export function wordsFromTokens(tokens: Array<{ text: string; start_ms?: number; end_ms?: number }>): WordTiming[] {
  const words: WordTiming[] = [];
  for (const t of tokens) {
    if (t.start_ms === undefined || t.end_ms === undefined) continue;
    const text = t.text;
    if (!text.trim()) continue;
    const startsWord = words.length === 0 || /^\s/.test(text);
    if (startsWord) words.push({ word: text.trim(), startS: t.start_ms / 1000, endS: t.end_ms / 1000 });
    else {
      const w = words[words.length - 1]!;
      w.word += text.trim();
      w.endS = t.end_ms / 1000;
    }
  }
  return words;
}

const CACHE_ROOT = join(process.env.HOME ?? "~", "pipeline", "tts-cache");

export async function synthesizeVoice(
  spec: VoiceSpec,
  opts: { text: string; outPath: string; previousText?: string; nextText?: string },
): Promise<VoiceClip> {
  if (spec.provider === "elevenlabs") {
    return synthesizeEleven({
      text: opts.text,
      voice: spec.voiceId,
      model: spec.model,
      speed: spec.speed,
      outPath: opts.outPath,
      previousText: opts.previousText,
      nextText: opts.nextText,
    });
  }

  // Soniox / Sarvam: cache by everything that shapes the audio, synthesize,
  // then measure word timings from the audio itself.
  const key = createHash("sha256")
    .update(JSON.stringify({ p: spec.provider, v: spec.voiceId, m: spec.model, l: spec.language, s: spec.speed, T: spec.temperature, t: opts.text }))
    .digest("hex")
    .slice(0, 24);
  const dir = join(CACHE_ROOT, spec.provider);
  const cachedWav = join(dir, `${key}.wav`);
  const cachedWords = join(dir, `${key}.words.json`);
  const cachedMeta = join(dir, `${key}.json`);
  let cached = existsSync(cachedWav) && existsSync(cachedWords) && existsSync(cachedMeta);

  if (!cached) {
    await mkdir(dir, { recursive: true });
    const clip =
      spec.provider === "soniox"
        ? await synthesizeSoniox({ text: opts.text, voice: spec.voiceId, model: spec.model, language: spec.language, speed: spec.speed, outPath: cachedWav })
        : await synthesizeSarvam({ text: opts.text, speaker: spec.voiceId, model: spec.model, language: spec.language, pace: spec.speed, temperature: spec.temperature, outPath: cachedWav });
    const transcript = await transcribeFile(cachedWav);
    await writeFile(cachedWords, JSON.stringify(wordsFromTokens(transcript.tokens), null, 2));
    await writeFile(cachedMeta, JSON.stringify({ voice: clip.voice, model: clip.model }));
  }

  await mkdir(join(opts.outPath, ".."), { recursive: true });
  await copyFile(cachedWav, opts.outPath);
  await copyFile(cachedWords, wordsSidecarPath(opts.outPath));
  const words = JSON.parse(await readFile(cachedWords, "utf8")) as WordTiming[];
  const meta = JSON.parse(await readFile(cachedMeta, "utf8")) as { voice: string; model: string };
  const probe = await probeMedia(opts.outPath);
  return { path: opts.outPath, durationS: probe.durationS ?? 0, voice: meta.voice, model: meta.model, words, cached };
}
