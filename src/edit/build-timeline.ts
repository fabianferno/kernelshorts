import { join, extname } from "node:path";
import { rm, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PalmierClient, PalmierCanvasError } from "../palmier/client.js";
import type { AddClipEntry, AddTextEntry } from "../palmier/client.js";
import { config } from "../config.js";
import type { ScriptJSON, AssetManifest, AcquiredAsset } from "../shared/schemas.js";
import { buildOverlay, captionArgs, needsScrim, type CaptionHighlight } from "./text-styles.js";
import { ensureScrim } from "./scrim.js";
import { correctCaptionText } from "./correct-captions.js";

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
  /** The exact words spoken — the ground truth captions must match. */
  voText: string;
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

/** Palmier writes new projects here. */
const PROJECTS_DIR = join(process.env.HOME ?? "", "Documents", "Palmier Pro");

/**
 * Removes a previous run's project package so the run can be repeated.
 *
 * Deliberately narrow: it only ever removes `<PROJECTS_DIR>/<runId>.palmier`,
 * and refuses a runId containing a path separator, so a malformed run id can
 * never reach outside the projects folder or delete a project a human made.
 */
async function removeStaleProject(runId: string): Promise<void> {
  if (runId.includes("/") || runId.includes("..") || runId.trim() === "") {
    throw new Error(`Refusing to clean up project for unsafe run id "${runId}"`);
  }
  const target = join(PROJECTS_DIR, `${runId}.palmier`);
  if (existsSync(target)) await rm(target, { recursive: true, force: true });
}

interface MediaAsset {
  id?: string;
  name?: string;
  folder?: string;
  durationSeconds?: number;
  generationStatus?: string;
}

/**
 * Polls the media library until every imported asset reports a duration.
 *
 * Palmier's directory import answers `status: "ready"` as soon as the files are
 * registered, but durations land asynchronously; using an asset before then
 * fails add_clips outright. Throws on timeout rather than proceeding with
 * unknown lengths, since every beat boundary is computed from these numbers.
 */
async function waitForDurations(
  client: PalmierClient,
  expected: number,
  timeoutMs = 60_000,
): Promise<{ assets: MediaAsset[] }> {
  const deadline = Date.now() + timeoutMs;
  let last: MediaAsset[] = [];

  while (Date.now() < deadline) {
    const media = (await client.getMedia()) as { assets?: MediaAsset[] };
    last = media.assets ?? [];
    const pending = last.filter(
      (a) => a.generationStatus !== undefined || !(a.durationSeconds && a.durationSeconds > 0),
    );
    if (last.length >= expected && pending.length === 0) return { assets: last };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const stuck = last
    .filter((a) => !(a.durationSeconds && a.durationSeconds > 0))
    .map((a) => `${a.folder}/${a.name}`);
  throw new Error(
    `Timed out waiting for imported media metadata after ${timeoutMs}ms. ` +
      `Assets still without a duration: ${stuck.join(", ") || "(none reported)"}`,
  );
}

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
      voText: beat.vo_text,
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
  /** Music bed level under the VO. PRD §4 suggests −12..−18 dB. Tuned by ear
   *  after the first real export: −16 still sat too loud under the voice. */
  musicDuckDb?: number;
  /** Active-word caption treatment: yellow word ("pop") or red plate ("block"). */
  captionHighlight?: CaptionHighlight;
  /**
   * Adjustments applied by the review loop (src/review/directives.ts). Absent on
   * the first build; populated from the reviewer's fix list on each iteration.
   */
  overrides?: BuildOverrides;
  /**
   * Leave the project open on return. The review loop needs it open to run the
   * timeline verifiers (get_timeline answers "Editor not available" once the
   * project closes) and closes it itself once the iteration is done.
   */
  keepOpen?: boolean;
  onProgress?: (message: string) => void;
}

/** Per-run and per-beat adjustments the review loop is allowed to make. */
export interface BuildOverrides {
  captionCenterY?: number;
  captionFontSize?: number;
  beats?: Record<
    string,
    {
      /** Extra frames trimmed off the head/tail of the beat's visual. */
      trimStartFrames?: number;
      trimEndFrames?: number;
      /** Multiplier on top of the fill transform. */
      zoom?: number;
      /** Vertical focus of that zoom. */
      centerY?: number;
      /** Force a title treatment, or drop the title entirely. */
      treatment?: "boxLight" | "boxDark" | "hardShadow" | "none";
      /**
       * Cut the beat's visual into two shots at this fraction of its length,
       * the second pushed in. Beat boundaries are set by the VO and cannot
       * move, so this is the only way to add visual change inside a long beat
       * — which is what the reviewer means by "this shot is held too long".
       */
      splitAt?: number;
    }
  >;
}

export async function buildTimeline(opts: BuildOptions): Promise<BuildResult> {
  const { client, script, manifest, workspace } = opts;
  const musicDuckDb = opts.musicDuckDb ?? -20;
  const log = opts.onProgress ?? (() => {});

  const plan = planBeats(script, manifest);
  const totalFrames = plan.at(-1)?.endFrame ?? 0;
  if (totalFrames === 0) throw new Error("Empty beat plan — nothing to build");

  // 1. A fresh 9:16 project per run. M0 confirmed this is native, so no
  //    template project needs to be kept in sync.
  //
  //    Reruns collide: `manage_project close` SAVES the .palmier package, it
  //    does not remove it, so a second run of the same run_id would be rejected
  //    with "a project named X already exists". Clear our own run-scoped
  //    package first, guarded so the path must end in exactly this run's name.
  await removeStaleProject(script.run_id);

  const project = await client.manageProject({
    action: "create",
    name: script.run_id,
    aspectRatio: "9:16",
    quality: "1080p",
    fps,
  });
  const projectPath = String(project.path ?? "");
  log(`created project ${projectPath} (${project.resolution})`);

  // 2. Stage every file into one directory, then import it in a SINGLE call.
  //
  //    Importing files one at a time reproducibly wedges Palmier: the first
  //    eight imports return in milliseconds and the ninth never returns, after
  //    which EVERY subsequent import hangs — including files that imported
  //    instantly moments earlier — while manage_project list and get_timeline
  //    keep answering normally. It survives an app restart of the client, so it
  //    is not client state. A burst of imports appears to saturate some
  //    internal queue.
  //
  //    A directory import (M0 §3: recursive, mirrors structure as media
  //    folders) moves the same nine files in one call, in 0.0s, with no hang.
  //    Staging also gives every asset a beat-keyed filename, so mapping the
  //    resulting media back to beats is exact rather than a fuzzy name match.
  const stageDir = join(workspace.root, "edit");
  await rm(stageDir, { recursive: true, force: true });
  for (const sub of ["vo", "visuals", "music"]) {
    await mkdir(join(stageDir, sub), { recursive: true });
  }

  for (const p of plan) {
    await copyFile(p.voPath, join(stageDir, "vo", `${p.beatId}${extname(p.voPath)}`));
    await copyFile(
      p.asset.path,
      join(stageDir, "visuals", `${p.beatId}${extname(p.asset.path)}`),
    );
  }
  if (manifest.music) {
    await copyFile(manifest.music.path, join(stageDir, "music", `bed${extname(manifest.music.path)}`));
  }
  if (manifest.overlays.length) {
    await mkdir(join(stageDir, "overlays"), { recursive: true });
    for (const o of manifest.overlays) {
      await copyFile(o.path, join(stageDir, "overlays", `${o.beat_id}.png`));
    }
  }

  const imported = await client.importMedia({ source: { path: stageDir } });
  log(`imported ${imported.imported ?? "?"} staged files in one directory call`);

  // A directory import reports status "ready" before every asset's metadata is
  // computed. add_clips then rejects the entry with "source needs a known
  // source length; this asset has none" — which surfaced only once the run grew
  // from 9 staged files to 13, i.e. it is a race, not a bad file. Wait for the
  // durations we are about to do frame math with.
  const media = await waitForDurations(client, plan.length * 2 + (manifest.music ? 1 : 0));
  const refFor = (folder: string, name: string): string => {
    const hit = media.assets?.find(
      (a) => a.folder?.endsWith(folder) && a.name === name,
    );
    if (!hit?.id) {
      throw new Error(
        `Staged asset "${folder}/${name}" is missing from the project library ` +
          `after the directory import.`,
      );
    }
    return hit.id;
  };

  const voRefs = new Map(plan.map((p) => [p.beatId, refFor("vo", p.beatId)]));
  const assetRefs = new Map(plan.map((p) => [p.beatId, refFor("visuals", p.beatId)]));
  const musicRef = manifest.music ? refFor("music", "bed") : undefined;

  // 3. Place visuals and VO in ONE call so tracks are created once. Omitting
  //    trackIndex on every entry gives one shared video track and one shared
  //    audio track (mixing specified/omitted is rejected).
  const entries: AddClipEntry[] = [];
  /** How many visual clips each beat contributed, in plan order. */
  const shotsPerBeat: number[] = [];

  for (const p of plan) {
    const beatSeconds = (p.endFrame - p.startFrame) / fps;
    const available = p.asset.durationS ?? beatSeconds;
    // Use at most what the asset actually has; if it is short, we slow it to
    // fit below rather than leaving a hole or freezing on the last frame.
    const take = Math.min(available, beatSeconds);
    const splitAt = opts.overrides?.beats?.[p.beatId]?.splitAt;

    if (splitAt && splitAt > 0.15 && splitAt < 0.85 && take > 1.5) {
      // Two shots from one source, continuing through the cut so motion does
      // not jump backwards. The second is pushed in during the transform pass.
      const cutFrame = p.startFrame + Math.round((p.endFrame - p.startFrame) * splitAt);
      const cutSeconds = take * splitAt;
      entries.push({
        mediaRef: assetRefs.get(p.beatId)!,
        startFrame: p.startFrame,
        source: [0, cutSeconds],
      });
      entries.push({
        mediaRef: assetRefs.get(p.beatId)!,
        startFrame: cutFrame,
        source: [cutSeconds, take],
      });
      shotsPerBeat.push(2);
    } else {
      entries.push({
        mediaRef: assetRefs.get(p.beatId)!,
        startFrame: p.startFrame,
        source: [0, take],
      });
      shotsPerBeat.push(1);
    }

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
  let clipCursor = 0;
  for (const [i, p] of plan.entries()) {
    const shots = shotsPerBeat[i] ?? 1;
    for (let shot = 0; shot < shots; shot++) {
    const clip = videoClips[clipCursor++];
    if (!clip) throw new Error(`Missing timeline clip for beat "${p.beatId}"`);
    const clipId = String(clip.id);
    const beatFrames = p.endFrame - p.startFrame;

    const fitted = fillTransform(p.asset.width ?? CANVAS_W, p.asset.height ?? CANVAS_H);

    // Screen recordings need an extra push. Sites render their full-width
    // layout even in a mobile viewport, so at 1080 wide the body text is
    // unreadable on a phone — the first M1 export was legible only as "a page
    // of links". Zooming past fill and biasing upward puts the headlines at a
    // readable size and keeps the top of the page (where the content is) in
    // frame instead of centring on whitespace. 1.55x was measured as still
    // too small on a real export; 2.4x is where HN headlines become legible.
    const beatOverride = opts.overrides?.beats?.[p.beatId];
    const isScreenRec = p.asset.kind === "screenrec";
    const baseZoom = beatOverride?.zoom ?? (isScreenRec ? 2.4 : 1);
    // The second shot of a split beat pushes in, so the cut is visible as a
    // change of framing rather than a jump in the same frame.
    const zoom = shot === 0 ? baseZoom : baseZoom * 1.3;
    const transform = {
      width: fitted.width * zoom,
      height: fitted.height * zoom,
      centerX: isScreenRec ? 0.42 : 0.5,
      centerY: beatOverride?.centerY ?? (isScreenRec ? 0.32 : 0.5),
    };
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
    // Review-loop trims: tighten a beat's visual without moving beat boundaries,
    // which are fixed by the VO and must not drift.
    const trimStart = beatOverride?.trimStartFrames ?? 0;
    const trimEnd = beatOverride?.trimEndFrames ?? 0;
    if (trimStart > 0 || trimEnd > 0) {
      await client.setClipProperties({
        clipIds: [clipId],
        ...(trimStart > 0 ? { trimStartFrame: trimStart } : {}),
        ...(trimEnd > 0 ? { trimEndFrame: trimEnd } : {}),
      });
    }

    const nested = clip.audio as { id?: string } | undefined;
    if (nested?.id) {
      await client.setClipProperties({ clipIds: [String(nested.id)], volumeDb: -60 });
    }
    }
  }
  const splitCount = shotsPerBeat.filter((n) => n > 1).length;
  log(
    `fitted visuals to 9:16 and muted source audio` +
      (splitCount ? ` (${splitCount} beat(s) cut into 2 shots)` : ""),
  );

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

  // 7b. Gradient scrim over beats whose title has no box behind it. It must sit
  //     ABOVE the footage and BELOW the text, which the track ordering gives us
  //     for free: add_clips without a trackIndex creates a video track above the
  //     existing visuals, and the add_texts calls below then create their tracks
  //     above that.
  const scrimBeats = plan.filter((p, i) => {
    const forced = opts.overrides?.beats?.[p.beatId]?.treatment;
    // A beat with no title (or one the reviewer removed) needs no scrim.
    if (!p.onScreenText || forced === "none") return false;
    return needsScrim(i, forced);
  });
  if (scrimBeats.length) {
    const scrimPath = await ensureScrim(join(workspace.root, "scrim.png"));
    const scrimMedia = await client.importMedia({
      source: { path: scrimPath },
      folder: "overlays",
      name: "scrim",
    });
    const scrimRef = String(scrimMedia.mediaRef);
    // One clip per beat rather than one long clip: the scrim should only darken
    // the beats that actually need it.
    await client.addClips(
      scrimBeats.map((p) => ({
        mediaRef: scrimRef,
        startFrame: p.startFrame,
        endFrame: p.endFrame,
      })),
    );
    log(`scrim over ${scrimBeats.length} unboxed-title beat(s)`);
  }

  // 7c. Image overlays — a logo or screenshot crop instead of a text title.
  //     Placed after the scrim so they sit above it, and before add_texts so
  //     any title still renders on top.
  if (manifest.overlays.length) {
    for (const overlay of manifest.overlays) {
      const beat = plan.find((p) => p.beatId === overlay.beat_id);
      if (!beat) continue;
      const ref = refFor("overlays", overlay.beat_id);
      const placed = await client.addClips([
        { mediaRef: ref, startFrame: beat.startFrame, endFrame: beat.endFrame },
      ]);
      const clipId = placed.clips?.[0]?.id;
      if (!clipId) continue;

      // An image auto-fits to CONTAIN the canvas, so its fitted width is 1 when
      // it is wider than 9:16 and less when taller. Scale from that fitted size
      // to the requested fraction of canvas width, preserving aspect.
      const canvasAspect = CANVAS_W / CANVAS_H;
      const imgAspect = overlay.width / overlay.height;
      const fittedWidth = imgAspect > canvasAspect ? 1 : imgAspect / canvasAspect;
      const factor = overlay.scale / fittedWidth;
      await client.setClipProperties({
        clipIds: [String(clipId)],
        transform: {
          width: fittedWidth * factor,
          height: (imgAspect > canvasAspect ? canvasAspect / imgAspect : 1) * factor,
          centerX: 0.5,
          centerY: overlay.centerY,
        },
      });
    }
    log(`placed ${manifest.overlays.length} image overlay(s)`);
  }

  // 8. Captions from the VO track, as two stacked layers so the stroke can be
  //    on the ordinary words but not on the highlighted one — see the comment
  //    on captionBaseArgs/captionHighlightArgs for why one layer cannot do both.
  //    Re-read between calls: each addCaptions creates a track and shifts indices.
  const afterMusic = await client.getTimeline();
  const findVoTrack = (timeline: Awaited<ReturnType<typeof client.getTimeline>>) =>
    timeline.tracks
      ?.filter((t) => t.type === "audio")
      .find((t) => {
        const clips = (t.clips as Array<Record<string, unknown>> | undefined) ?? [];
        return clips.length === plan.length;
      }) ?? audioTracks[0];

  const voTrack = findVoTrack(afterMusic);

  if (voTrack?.index !== undefined) {
    const captions = captionArgs(opts.captionHighlight ?? "block");
    if (opts.overrides?.captionCenterY !== undefined) {
      captions.transform = { ...captions.transform, y: opts.overrides.captionCenterY };
    }
    if (opts.overrides?.captionFontSize !== undefined) {
      captions.style = { ...captions.style, fontSize: opts.overrides.captionFontSize };
    }
    await client.addCaptions({ trackIndex: Number(voTrack.index), ...captions });
    log(`captions generated (${opts.captionHighlight ?? "block"} highlight)`);

    // Captions are transcribed from the audio, but we KNOW the words — the
    // script produced that audio. Rewrite the text to the script so an ASR
    // mishearing never gets burned into the video.
    const corrected = await correctCaptionText(client, plan);
    log(
      `caption text checked against script: ${corrected.clipsRewritten}/` +
        `${corrected.clipsChecked} clip(s) rewritten`,
    );
  }

  // 9. On-screen text per beat, above the captions. The style cycles per beat
  //    so one short doesn't repeat a single look.
  //     buildOverlay returns one entry per stacked LAYER. Layers must go on
  //     separate tracks: clips on the same track are sequential, so two text
  //     clips sharing a frame range on one track silently overwrite each other
  //     — the "mixed" variant lost its first line entirely that way, rendering
  //     only "age^gravity" with "points /" gone. One add_texts call per layer
  //     creates one track per layer. Beats never overlap in time, so all beats'
  //     layer-0 entries share a track safely.
  const overlays = plan.map((p, i) => {
    const forced = opts.overrides?.beats?.[p.beatId]?.treatment;
    if (!p.onScreenText || forced === "none") return [];
    return buildOverlay({
      text: p.onScreenText,
      startFrame: p.startFrame,
      endFrame: p.endFrame,
      index: i,
      treatment: forced,
    });
  });
  const layerCount = Math.max(0, ...overlays.map((o) => o.length));
  const layers: AddTextEntry[][] = [];
  for (let layer = 0; layer < layerCount; layer++) {
    const entries = overlays.map((o) => o[layer]).filter((e): e is AddTextEntry => Boolean(e));
    if (entries.length) layers.push(entries);
  }
  const texts = layers.flat();
  for (const entries of layers) {
    await client.addTexts(entries);
  }
  if (texts.length) {
    log(`added ${texts.length} text overlays across ${layers.length} layer track(s)`);
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

  // 12. Close the project. Leaving run projects open degrades the app: after a
  //     session's worth of accumulated open projects, `import_media` began
  //     hanging indefinitely on every file — including files that had imported
  //     in milliseconds minutes earlier — while `manage_project list` and
  //     `get_timeline` kept answering normally. Restarting Palmier cleared it.
  //     A daily worker must not leak projects.
  if (!opts.keepOpen) await client.manageProject({ action: "close" });

  return {
    projectPath,
    timelineId: String(afterMusic.id ?? ""),
    plan,
    totalFrames,
    exportPath,
    checkpointPath,
  };
}
