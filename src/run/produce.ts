import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { synthesizeVoice, type VoiceSpec } from "../tts/voice.js";
import { textForProvider } from "../tts/delivery.js";
import { acquireAssets } from "../assets/acquire.js";
import { themesForBeats } from "../edit/studio.js";
import { resolveCatalogMusic } from "../assets/music-catalog.js";
import { loadBrand } from "../host/characters.js";
import { setPhase, saveState, emit, type Workspace } from "./workspace.js";
import { putArtifact } from "./artifacts.js";
import { config } from "../config.js";
import type { AssetManifest, RunState, ScriptJSON, VoiceoverClip } from "../shared/schemas.js";

/**
 * Script → voiceover → asset manifest. Everything the edit phase needs that is
 * not the edit itself.
 *
 * The script is an INPUT now. It used to be the output of an HN research and
 * fact-check phase; that phase is gone, so whatever writes the script (you, a
 * chat session, a future ideation tool) hands it in and this takes it from
 * there.
 */
export interface ProduceOptions {
  runId: string;
  ws: Workspace;
  state: RunState;
  script: ScriptJSON;
  /** Provider + voice (the character\'s, unless overridden). */
  voice: VoiceSpec;
  onProgress?: (message: string) => void;
}

export interface ProduceResult {
  state: RunState;
  manifest: AssetManifest;
  voTotalS: number;
  durationWarning?: string;
}

export async function produceVoiceAndAssets(opts: ProduceOptions): Promise<ProduceResult> {
  const { runId, ws, script, voice } = opts;
  const log = opts.onProgress ?? (() => {});
  let state = opts.state;

  await writeFile(join(ws.root, "script.json"), JSON.stringify(script, null, 2));

  // ── Music FIRST: if the catalog is unreachable (e.g. heygen not signed in)
  //    fail before any ElevenLabs credits are spent. Length is the script's
  //    upper bound; the bed is trimmed to the real VO length at build time.
  const maxS = script.beats.reduce((s, b) => s + b.max_duration_s, 0) + 2;
  const music =
    config.musicSource === "heygen"
      ? await resolveCatalogMusic(loadBrand().musicStyle ?? script.music_mood, join(ws.root, "music"), maxS, log)
      : undefined;

  // ── TTS: audio-first, real measured durations ───────────────────────────
  state = await setPhase(ws, state, "tts");
  const voiceover: VoiceoverClip[] = [];
  const beats = script.beats;
  for (const [i, beat] of beats.entries()) {
    const clip = await synthesizeVoice(voice, {
      // Delivery tags translated for this provider (verbatim for Soniox,
      // punctuation for Sarvam/ElevenLabs — never read aloud).
      text: textForProvider(beat.vo_text, voice.provider),
      outPath: join(ws.vo, `${beat.id}.wav`),
      // Neighbouring beats keep the intonation continuous across clip boundaries.
      previousText: beats[i - 1] && textForProvider(beats[i - 1]!.vo_text, voice.provider),
      nextText: beats[i + 1] && textForProvider(beats[i + 1]!.vo_text, voice.provider),
    });
    log(`  vo ${beat.id}: ${clip.durationS.toFixed(2)}s${clip.cached ? " (cached, 0 credits)" : ""}`);
    voiceover.push({
      beat_id: beat.id,
      path: clip.path,
      durationS: clip.durationS,
      voice: clip.voice,
      model: clip.model,
    });
  }
  const voTotal = voiceover.reduce((s, v) => s + v.durationS, 0);
  const { min, max } = config.video.targetDurationS;
  const durationWarning =
    voTotal < min
      ? `VO totals ${voTotal.toFixed(1)}s, under the ${min}s floor — add a beat.`
      : voTotal > max
        ? `VO totals ${voTotal.toFixed(1)}s, over the ${max}s ceiling — trim a beat.`
        : undefined;
  log(
    `VO total: ${voTotal.toFixed(1)}s (window ${min}-${max}s)` +
      (durationWarning ? `\n  WARNING: ${durationWarning}` : ""),
  );
  if (durationWarning) await emit(runId, "tts", "log", durationWarning);

  // ── Assets ──────────────────────────────────────────────────────────────
  state = await setPhase(ws, state, "assets");
  // Studio layout: generated scenes are painted on their beat's backdrop.
  const themeList = themesForBeats(script.beats);
  const themes = Object.fromEntries(script.beats.map((b, i) => [b.id, themeList[i]!]));
  // music: false — the vault tracks are not to be used (user, 2026-11-06).
  // A music bed comes back once a generation/catalog source is chosen.
  const acquired = await acquireAssets(script, ws.root, { voiceover, themes, music: false });
  const manifest = music ? { ...acquired, music } : acquired;
  for (const a of manifest.assets) {
    log(`  ${a.beat_id}: ${a.kind} ${a.width}x${a.height} (${a.license.provider})`);
  }
  state = await saveState(ws, { ...state, script, manifest });

  await putArtifact(runId, join(ws.root, "script.json"), { kind: "script", phase: "script" });
  for (const v of voiceover) {
    await putArtifact(runId, v.path, { kind: "voiceover", phase: "tts", label: v.beat_id });
  }

  return { state, manifest, voTotalS: Number(voTotal.toFixed(2)), durationWarning };
}
