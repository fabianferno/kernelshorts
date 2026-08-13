import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listVoices, synthesize } from "./soniox.js";
import { transcribeFile, wordSimilarity } from "../verify/timeline.js";

/**
 * TTS bake-off (PRD §3.7).
 *
 * The PRD framed this as choosing a *provider* (ElevenLabs / OpenAI / Cartesia).
 * §8 settled that — Soniox — so what is actually undecided, and what this
 * measures, is which Soniox voice and model to narrate with.
 *
 * What can be measured honestly, and what cannot:
 *  - INTELLIGIBILITY is measurable. Synthesize a known script, transcribe the
 *    result, and compare word-for-word. A voice whose own words do not survive
 *    a round trip through a speech recognizer will not survive a viewer either,
 *    and it breaks the script-fidelity verifier downstream.
 *  - PACE is measurable, in words per second of real audio.
 *  - Whether a voice sounds GOOD is not measurable here, and this module does
 *    not pretend to score it. It ranks on intelligibility, reports the pace,
 *    and leaves the samples on disk for a person to listen to. That listening
 *    step is the actual decision.
 */

/**
 * Deliberately awkward: the em dash, the numeral, the acronym, and the domain
 * name are where TTS engines diverge and where a round-trip comparison finds
 * real differences. A bland sentence scores every voice identically.
 */
export const BAKEOFF_SCRIPT =
  "Every morning, one plain text page decides what half of tech talks about. " +
  "Hacker News has no algorithm chasing your attention — stories rise on votes " +
  "and fall on time. Roughly 5 million people read it each month, and the top " +
  "spot can send 40,000 visitors to a side project overnight.";

/** Matches WORDS_PER_SECOND in the script generator — the pace the written
 *  word budget assumes. Kept as a separate constant because this one is a
 *  preference used to rank voices, not a measurement of a chosen one. */
export const PREFERRED_WPS = 2.6;

export interface BakeoffEntry {
  voice: string;
  voiceId: string;
  model: string;
  path: string;
  durationS: number;
  wordsPerSecond: number;
  /** Word-level similarity of the STT round trip against BAKEOFF_SCRIPT. */
  fidelity: number;
  error?: string;
}

export interface BakeoffResult {
  entries: BakeoffEntry[];
  /** Highest fidelity among the entries that actually rendered. */
  winner?: BakeoffEntry;
  reportPath: string;
}

/**
 * Runs every ready (voice, model) pair on the account for real and scores it.
 *
 * Built-in voices are included by name; cloned voices only on models where
 * Soniox reports status "ready", because any other state returns 409
 * voice_not_prepared rather than audio.
 */
export async function runBakeoff(opts: {
  outDir: string;
  /** Built-in Soniox voices to include alongside the account's clones. */
  builtIns?: string[];
  text?: string;
}): Promise<BakeoffResult> {
  const text = opts.text ?? BAKEOFF_SCRIPT;
  await mkdir(opts.outDir, { recursive: true });

  const candidates: Array<{ label: string; voice: string; model: string }> = [];
  for (const v of await listVoices()) {
    for (const m of v.models) {
      if (m.status === "ready") {
        candidates.push({ label: v.name, voice: v.id, model: m.model });
      }
    }
  }
  for (const name of opts.builtIns ?? []) {
    // Built-ins are usable on any model, so pin them to the newest one the
    // account's clones are ready on to keep the comparison like-for-like.
    const models = [...new Set(candidates.map((c) => c.model))].sort().reverse();
    for (const model of models.length ? models.slice(0, 1) : ["tts-rt-v2"]) {
      candidates.push({ label: name, voice: name, model });
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      "No Soniox voice is ready on any model, and no built-in voices were " +
        "requested — there is nothing to bake off.",
    );
  }

  const entries: BakeoffEntry[] = [];
  for (const c of candidates) {
    const path = join(opts.outDir, `${slug(c.label)}-${c.model}.wav`);
    try {
      const clip = await synthesize({ text, voice: c.voice, model: c.model, outPath: path });
      const transcript = await transcribeFile(path);
      const sim = wordSimilarity(text, transcript.text);
      entries.push({
        voice: c.label,
        voiceId: c.voice,
        model: c.model,
        path,
        durationS: clip.durationS,
        wordsPerSecond: Number((text.split(/\s+/).length / clip.durationS).toFixed(2)),
        fidelity: Number(sim.ratio.toFixed(3)),
      });
    } catch (err) {
      // A voice that fails to render is a result, not a reason to abandon the
      // comparison — the others still need scoring.
      entries.push({
        voice: c.label,
        voiceId: c.voice,
        model: c.model,
        path,
        durationS: 0,
        wordsPerSecond: 0,
        fidelity: 0,
        error: (err as Error).message.slice(0, 300),
      });
    }
  }

  // Fidelity first, then pace. Measured on this account 2026-08-13: six of the
  // eight working voices round-tripped at exactly 1.000, so fidelity ELIMINATES
  // (the two clone entries scored 0.94 and 0.96 — a real, audible difference)
  // but does not RANK. Pace is the tiebreak that still means something: a voice
  // near PREFERRED_WPS fits the word budget the script generator writes to.
  entries.sort(
    (a, b) =>
      b.fidelity - a.fidelity ||
      Math.abs(a.wordsPerSecond - PREFERRED_WPS) - Math.abs(b.wordsPerSecond - PREFERRED_WPS),
  );
  const winner = entries.find((e) => !e.error && e.fidelity > 0);

  const reportPath = join(opts.outDir, "bakeoff.json");
  await writeFile(
    reportPath,
    JSON.stringify({ text, ranAt: new Date().toISOString(), entries }, null, 2),
  );

  return { entries, winner, reportPath };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
