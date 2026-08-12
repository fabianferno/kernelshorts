import { join } from "node:path";
import { PalmierClient, PalmierCanvasError } from "../palmier/client.js";
import type { AddClipEntry, AddTextEntry } from "../palmier/client.js";
import { config } from "../config.js";
import type { ScriptJSON, AssetManifest, AcquiredAsset } from "../shared/schemas.js";

/**
 * The edit agent (PRD §4).
 *
 * Audio-first: measured VO durations define every beat boundary, and visuals
 * are fitted to those boundaries — never the reverse. Nothing here estimates a
 * duration; every number comes from a real ffprobe measurement made during
 * acquisition.
 *
 * The build is deterministic rather than LLM-driven. An LLM decides *what* the
 * video says (script) and *how it scores* (review); assembling a timeline from
 * a manifest is arithmetic, and arithmetic should not be delegated to a model
 * that might hallucinate a frame number.
 */

const { fps, width: CANVAS_W, height: CANVAS_H } = config.video;

/** Breathing room between beats so cuts don't land on the VO's last syllable. */
const BEAT_PAD_FRAMES = 4;

export interface BeatPlan {
  beatId: string;
  startFrame: number;
  endFrame: number;
  voPath: string;
  voDurationS: number;
  asset: AcquiredAsset;
  onScreenText?: string;
}

export interface BuildResult {
  projectPath: string;
  timelineId: string;
  plan: BeatPlan[];
  totalFrames: number;
  exportPath: string;
  checkpointPath: string;
}

const secToFrames = (s: number): number => Math.round(s * fps);

/**
 * Lays out beats end to end from measured VO durations. This is the single
 * source of truth for timing; every later step reads frames from here.
 */
export function planBeats(script: ScriptJSON, manifest: AssetManifest): BeatPlan[] {
  const plan: BeatPlan[] = [];
  let cursor = 0;

  for (const beat of script.beats) {
    const vo = manifest.voiceover.find((v) => v.beat_id === beat.id);
    if (!vo) throw new Error(`No voiceover clip for beat "${beat.id}"`);
    const asset = manifest.assets.find((a) => a.beat_id === beat.id);
    if (!asset) throw new Error(`No visual asset for beat "${beat.id}"`);

    const frames = secToFrames(vo.durationS) + BEAT_PAD_FRAMES;
    plan.push({
      beatId: beat.id,
      startFrame: cursor,
      endFrame: cursor + frames,
      voPath: vo.path,
      voDurationS: vo.durationS,
      asset,
      onScreenText: beat.on_screen_text,
    });
    cursor += frames;
  }
  return plan;
}

/**
 * Fills a 9:16 canvas with a source of any aspect, cropping the overflow.
 *
 * Palmier auto-fits imported media to *contain* (a 16:9 source lands at
 * height 0.316, pillarboxed with black bars). Shorts must fill the frame, so
 * we scale by the reciprocal of the fitted dimension. Measured live in M0:
 * 1280x720 into 1080x1920 needs width 3.165.
 */
export function fillTransform(assetW: number, assetH: number): {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
} {
  const canvasAspect = CANVAS_W / CANVAS_H;
  const assetAspect = assetW / assetH;

  if (assetAspect > canvasAspect) {
    // Wider than the canvas: match height, overflow horizontally.
    return { width: assetAspect / canvasAspect, height: 1, centerX: 0.5, centerY: 0.5 };
  }
  // Taller than the canvas (or exactly 9:16): match width, overflow vertically.
  return { width: 1, height: canvasAspect / assetAspect, centerX: 0.5, centerY: 0.5 };
}

export interface BuildOptions {
  client: PalmierClient;
  script: ScriptJSON;
  manifest: AssetManifest;
  workspace: { root: string; exports: string; checkpoints: string };
  /** Music bed level under the VO. PRD §4 suggests −12..−18 dB; tuned by ear. */
  musicDuckDb?: number;
  onProgress?: (message: string) => void;
}

export async function buildTimeline(opts: BuildOptions): Promise<BuildResult> {
  const { client, script, manifest, workspace } = opts;
  const musicDuckDb = opts.musicDuckDb ?? -16;
  const log = opts.onProgress ?? (() => {});

  const plan = planBeats(script, manifest);
  const totalFrames = plan.at(-1)?.endFrame ?? 0;
  if (totalFrames === 0) throw new Error("Empty beat plan — nothing to build");

  // 1. A fresh 9:16 project per run. M0 confirmed this is native, so no
  //    template project needs to be kept in sync.
  const project = await client.manageProject({
    action: "create",
    name: script.run_id,
    aspectRatio: "9:16",
    quality: "1080p",
    fps,
  });
  const projectPath = String(project.path ?? "");
  log(`created project ${projectPath} (${project.resolution})`);

  // 2. Import every local file. Local paths resolve synchronously — no polling
  //    (M0 §3). Imports are sequential because each returns the mediaRef we need.
  const voRefs = new Map<string, string>();
  for (const p of plan) {
    const res = await client.importMedia({
      source: { path: p.voPath },
      folder: "vo",
      name: `vo-${p.beatId}`,
    });
    voRefs.set(p.beatId, String(res.mediaRef));
  }

  const assetRefs = new Map<string, string>();
  for (const p of plan) {
    const res = await client.importMedia({
      source: { path: p.asset.path },
      folder: "visuals",
      name: `visual-${p.beatId}`,
    });
    assetRefs.set(p.beatId, String(res.mediaRef));
  }

  let musicRef: string | undefined;
  if (manifest.music) {
    const res = await client.importMedia({
      source: { path: manifest.music.path },
      folder: "music",
      name: manifest.music.name,
    });
    musicRef = String(res.mediaRef);
  }
  log(`imported ${voRefs.size} VO + ${assetRefs.size} visuals${musicRef ? " + music" : ""}`);

  // 3. Place visuals and VO in ONE call so tracks are created once. Omitting
  //    trackIndex on every entry gives one shared video track and one shared
  //    audio track (mixing specified/omitted is rejected).
  const entries: AddClipEntry[] = [];
  for (const p of plan) {
    const beatSeconds = (p.endFrame - p.startFrame) / fps;
    const available = p.asset.durationS ?? beatSeconds;
    // Use at most what the asset actually has; if it is short, we slow it to
    // fit below rather than leaving a hole or freezing on the last frame.
    const take = Math.min(available, beatSeconds);
    entries.push({
      mediaRef: assetRefs.get(p.beatId)!,
      startFrame: p.startFrame,
      source: [0, take],
    });
    entries.push({
      mediaRef: voRefs.get(p.beatId)!,
      startFrame: p.startFrame,
      source: [0, p.voDurationS],
    });
  }
  const placed = await client.addClips(entries);
  log(`placed ${placed.clips?.length ?? 0} clips across ${plan.length} beats`);

  // 4. THE M0 CANVAS HIJACK. Placing landscape media silently re-sets the
  //    canvas (a 1080x1920 project became 1280x720 with only an advisory note).
  //    Re-assert, then verify — assertCanvas throws rather than repairing, so a
  //    second failure surfaces instead of being papered over.
  try {
    await client.assertCanvas(CANVAS_W, CANVAS_H);
  } catch (err) {
    if (!(err instanceof PalmierCanvasError)) throw err;
    log(`canvas hijacked (${err.message}) — restoring ${CANVAS_W}x${CANVAS_H}`);
    await client.setProjectSettings({ width: CANVAS_W, height: CANVAS_H });
    await client.assertCanvas(CANVAS_W, CANVAS_H);
  }

  // 5. Re-read: adding clips created tracks, so every cached index is stale.
  const timeline = await client.getTimeline();
  const videoTrack = timeline.tracks?.find((t) => t.type === "video");
  const audioTracks = timeline.tracks?.filter((t) => t.type === "audio") ?? [];
  if (!videoTrack) throw new Error("No video track after add_clips");

  const videoClips = (videoTrack.clips as Array<Record<string, unknown>> | undefined) ?? [];

  // 6. Fit each visual to fill the frame, mute its own audio (the VO carries
  //    the sound), and slow any clip that came up short of its beat.
  for (const [i, p] of plan.entries()) {
    const clip = videoClips[i];
    if (!clip) throw new Error(`Missing timeline clip for beat "${p.beatId}"`);
    const clipId = String(clip.id);
    const beatFrames = p.endFrame - p.startFrame;

    const transform = fillTransform(
      p.asset.width ?? CANVAS_W,
      p.asset.height ?? CANVAS_H,
    );
    await client.setClipProperties({ clipIds: [clipId], transform });

    const frames = Array.isArray(clip.frames) ? (clip.frames as number[]) : undefined;
    const actualFrames = frames ? frames[1]! - frames[0]! : beatFrames;
    if (actualFrames < beatFrames) {
      // Stretch to the beat instead of leaving a gap. speed < 1 lengthens.
      await client.setClipProperties({
        clipIds: [clipId],
        speed: actualFrames / beatFrames,
        durationFrames: beatFrames,
      });
    }

    // A video clip's audio partner is nested inside it, not on its own row.
    const nested = clip.audio as { id?: string } | undefined;
    if (nested?.id) {
      await client.setClipProperties({ clipIds: [String(nested.id)], volumeDb: -60 });
    }
  }
  log("fitted visuals to 9:16 and muted source audio");

  // 7. Music bed: its own track, ducked under the VO, faded at both ends.
  if (musicRef && manifest.music) {
    const musicSeconds = totalFrames / fps;
    const musicResult = await client.addClips([
      { mediaRef: musicRef, startFrame: 0, source: [0, musicSeconds] },
    ]);
    const musicClip = musicResult.clips?.[0];
    if (musicClip?.id) {
      await client.setClipProperties({
        clipIds: [String(musicClip.id)],
        volumeDb: musicDuckDb,
        fadeInFrames: Math.round(fps * 0.5),
        fadeOutFrames: Math.round(fps * 1.5),
        fadeOutInterpolation: "smooth",
      });
    }
    log(`music bed "${manifest.music.name}" ducked to ${musicDuckDb} dB`);
  }

  // 8. Captions from the VO track. Re-read first — the music add may have
  //    created another audio track and shifted indices again.
  const afterMusic = await client.getTimeline();
  const voTrack = afterMusic.tracks
    ?.filter((t) => t.type === "audio")
    .find((t) => {
      const clips = (t.clips as Array<Record<string, unknown>> | undefined) ?? [];
      return clips.length === plan.length;
    }) ?? audioTracks[0];

  if (voTrack?.index !== undefined) {
    await client.addCaptions({
      trackIndex: Number(voTrack.index),
      maxWords: 4,
      // Keep the bottom ~25% and top 10% clear of platform UI (PRD §5).
      transform: { centerX: 0.5, centerY: 0.68 },
      style: {
        fontSize: 64,
        bold: true,
        color: "#FFFFFF",
        outline: { enabled: true, color: "#000000", width: 6 },
        fontCase: "uppercase",
      },
      animation: "wordPop",
    });
    log("captions generated from the VO track");
  }

  // 9. On-screen text per beat, above the captions.
  const texts: AddTextEntry[] = plan
    .filter((p) => p.onScreenText)
    .map((p) => ({
      content: p.onScreenText!,
      startFrame: p.startFrame,
      endFrame: p.endFrame,
      animation: "slideUp" as const,
      transform: { centerX: 0.5, centerY: 0.22 },
      style: {
        fontSize: 78,
        bold: true,
        color: "#FFFFFF",
        alignment: "center" as const,
        shadow: { enabled: true, color: "#000000", opacity: 0.7, blur: 18 },
      },
    }));
  if (texts.length) {
    await client.addTexts(texts);
    log(`added ${texts.length} on-screen text overlays`);
  }

  // 10. Checkpoint the project before exporting, so a bad review iteration can
  //     be rolled back to a known-good state (PRD §4).
  const checkpointPath = join(workspace.checkpoints, `${script.run_id}-v1.palmier`);
  await client.exportProject({ mode: "palmier", outputPath: checkpointPath });

  // 11. Export. Re-verified with ffprobe by the caller; note this file is NOT
  //     the publish master — it still needs loudness normalization (M0).
  const exportPath = join(workspace.exports, `${script.run_id}.mp4`);
  await client.exportAndWait(exportPath, {
    mode: "video",
    codec: "H.264",
    resolution: "Match Timeline",
  });
  log(`exported ${exportPath}`);

  return {
    projectPath,
    timelineId: String(afterMusic.id ?? ""),
    plan,
    totalFrames,
    exportPath,
    checkpointPath,
  };
}
