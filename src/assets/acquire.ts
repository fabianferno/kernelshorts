import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import {
  AcquiredAsset,
  AssetManifest,
  type Beat,
  type GeneratedScene,
  type ScriptJSON,
  type VoiceoverClip,
} from "../shared/schemas.js";
import { probeMedia } from "./ffprobe.js";

const exec = promisify(execFile);

/** Frame size for a user photo/clip, by how the compositor frames it. */
const FRAME_FOR_FIT = { card: { w: 1080, h: 960 }, full: { w: 1080, h: 1920 } } as const;
import { recordScreen } from "./screenrec.js";
import { renderScene } from "./generated/index.js";
import type { SceneTheme } from "./generated/page.js";
import { acquireStock } from "./stock.js";
import { selectMusic } from "./music.js";
import { acquireOverlayImage } from "./overlay-image.js";

export type AcquireOptions = {
  /** VO clips measured by the TTS phase; beat durations come from them (PRD §3.7). */
  voiceover?: VoiceoverClip[];
  /** Set false to skip music selection (used when the caller supplies its own bed). */
  music?: boolean;
  /** Cap on concurrent beat acquisitions — browsers and downloads are heavy. */
  concurrency?: number;
  /**
   * Studio layout: per-beat theme, so generated scenes are rendered on the
   * matching light/dark backdrop (edit/studio.ts themesForBeats). Absent →
   * the original dark scene look.
   */
  themes?: Record<string, SceneTheme>;
};

/** How much footage this beat needs: the measured VO clip if we have it,
 *  otherwise the script's upper bound. */
function neededSeconds(beat: Beat, voiceover: VoiceoverClip[]): number {
  return voiceover.find((v) => v.beat_id === beat.id)?.durationS ?? beat.max_duration_s;
}

/** Stills: a local path is copied into the workspace, an https URL is downloaded.
 *  Palmier imports local paths synchronously (M0 §3), so everything lands on disk
 *  before the edit phase starts. */
/**
 * A photo becomes a short video at its beat's length, framed for the card or
 * the full frame, with a slow Ken Burns push so it isn't a dead frame. The
 * studio compositor draws every non-generated asset as a <video>; an image
 * handed to it raw would render nothing.
 */
async function acquireStill(
  spec: { source: string; kenBurns: boolean; fit?: "card" | "full" },
  workspace: string,
  beatId: string,
  neededS: number,
): Promise<AcquiredAsset> {
  const { source } = spec;
  const outDir = join(workspace, "assets");
  await mkdir(outDir, { recursive: true });

  let image: string;
  let sourceUrl: string | undefined;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`still download failed: ${res.status} ${source}`);
    const ext = extname(new URL(source).pathname) || ".jpg";
    image = join(outDir, `${beatId}-still-src${ext}`);
    await writeFile(image, Buffer.from(await res.arrayBuffer()));
    sourceUrl = source;
  } else {
    if (!isAbsolute(source)) throw new Error(`still source must be absolute or https: ${source}`);
    if (!existsSync(source)) throw new Error(`still source does not exist: ${source}`);
    image = join(outDir, `${beatId}-still-src${extname(source)}`);
    if (image !== source) await copyFile(source, image);
  }

  const fit = spec.fit ?? "card";
  const { w, h } = FRAME_FOR_FIT[fit];
  const fps = 30;
  const durationS = Math.max(1, neededS + 0.5);
  const frames = Math.ceil(durationS * fps);
  const cover = `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2}`;
  const motion = spec.kenBurns
    ? `,zoompan=z='1+0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`
    : `,scale=${w}:${h}`;
  const dest = join(outDir, `${beatId}-still.mp4`);
  await exec("ffmpeg", [
    "-v", "error", "-y", "-loop", "1", "-framerate", String(fps), "-i", image,
    "-vf", `${cover}${motion},format=yuv420p`, "-t", String(durationS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an", dest,
  ]);

  const info = await probeMedia(dest);
  return AcquiredAsset.parse({
    beat_id: beatId,
    kind: "still",
    path: dest,
    fit,
    durationS: info.durationS,
    width: info.width,
    height: info.height,
    fps: info.fps,
    sourceUrl,
    license: {
      provider: sourceUrl ? "external-still" : "user",
      url: sourceUrl,
      attribution: sourceUrl ?? `User photo ${basename(source)}`,
    },
  });
}

/**
 * The user's own video: a local file or any link yt-dlp can fetch, trimmed to
 * [start, end], framed for card/full, muted (the VO carries the sound).
 */
async function acquireClip(
  spec: { source: string; start?: number; end?: number; fit?: "card" | "full" },
  workspace: string,
  beatId: string,
  neededS: number,
): Promise<AcquiredAsset> {
  const outDir = join(workspace, "assets");
  await mkdir(outDir, { recursive: true });
  let input = spec.source;
  let sourceUrl: string | undefined;
  if (/^https?:\/\//.test(spec.source)) {
    const dl = join(outDir, `${beatId}-clip-src`);
    await mkdir(dl, { recursive: true });
    await exec("yt-dlp", ["--no-playlist", "-f", "mp4/bestvideo*+bestaudio/best", "--merge-output-format", "mp4",
      "-o", join(dl, "src.%(ext)s"), spec.source], { maxBuffer: 1 << 24, timeout: 300_000 });
    const got = (await readdir(dl)).find((f) => f.startsWith("src."));
    if (!got) throw new Error(`clip download produced nothing: ${spec.source}`);
    input = join(dl, got);
    sourceUrl = spec.source;
  } else if (!isAbsolute(input) || !existsSync(input)) {
    throw new Error(`clip source must be an existing absolute path or a URL: ${spec.source}`);
  }
  const fit = spec.fit ?? "card";
  const { w, h } = FRAME_FOR_FIT[fit];
  const start = spec.start ?? 0;
  const length = spec.end !== undefined ? Math.max(0.5, spec.end - start) : neededS + 0.5;
  const dest = join(outDir, `${beatId}-clip.mp4`);
  await exec("ffmpeg", [
    "-v", "error", "-y", "-ss", String(start), "-i", input, "-t", String(length),
    "-vf", `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=30,format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an", dest,
  ], { maxBuffer: 1 << 24 });
  const info = await probeMedia(dest);
  return AcquiredAsset.parse({
    beat_id: beatId,
    kind: "clip",
    path: dest,
    fit,
    durationS: info.durationS,
    width: info.width,
    height: info.height,
    fps: info.fps,
    sourceUrl,
    license: { provider: sourceUrl ? "user-link" : "user", url: sourceUrl, attribution: `User clip ${basename(spec.source)}` },
  });
}

async function acquireBeat(
  beat: Beat,
  workspace: string,
  voiceover: VoiceoverClip[],
  theme?: SceneTheme,
): Promise<AcquiredAsset> {
  const needed = neededSeconds(beat, voiceover);
  switch (beat.visual.type) {
    case "screenrec":
      return recordScreen(beat.visual, {
        workspace,
        beatId: beat.id,
        maxDurationS: beat.max_duration_s,
      });
    case "stock":
      return acquireStock(beat.visual, { workspace, beatId: beat.id, neededS: needed });
    case "still":
      return acquireStill(beat.visual, workspace, beat.id, needed);
    case "clip":
      return acquireClip(beat.visual, workspace, beat.id, needed);
    case "generated":
      return acquireGenerated(beat.visual.spec, workspace, beat.id, needed, theme);
  }
}

/** Renders a generated scene (PRD §4a) to exactly the beat's measured VO length.
 *
 *  Unlike stock and screenrec — which yield footage longer than the beat and get
 *  trimmed on the timeline — the renderer is told the duration up front, because
 *  the animation has to be *paced* to it: a diagram whose packets finish moving
 *  in 2s of a 7s beat is a still frame for 5s. */
export async function acquireGenerated(
  spec: GeneratedScene,
  workspace: string,
  beatId: string,
  durationS: number,
  theme?: SceneTheme,
): Promise<AcquiredAsset> {
  const outDir = join(workspace, "assets");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${beatId}-generated.mp4`);

  const rendered = await renderScene({ spec, durationS, outPath, theme });

  return AcquiredAsset.parse({
    beat_id: beatId,
    kind: "generated",
    path: rendered.path,
    durationS: rendered.durationS,
    width: rendered.width,
    height: rendered.height,
    fps: rendered.fps,
    // No third-party rights are involved: we rendered these frames ourselves
    // from parameters the script supplied. Saying "Pexels" here would be a lie
    // on the attribution record that ships with the published video.
    license: {
      provider: "self-rendered",
      attribution: `Generated "${spec.scene}" scene rendered by kernelshorts`,
    },
  });
}

/** Bounded parallelism: results stay in beat order regardless of finish order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Dispatches every beat's VisualSpec to the right acquirer and returns a
 * schema-validated AssetManifest.
 *
 * A short with a missing visual is not a partial success: the first beat that
 * fails fails the whole manifest, with the beat named in the error (PRD §0).
 */
export async function acquireAssets(
  script: ScriptJSON,
  workspace: string,
  opts: AcquireOptions = {},
): Promise<AssetManifest> {
  const voiceover = opts.voiceover ?? [];
  await mkdir(join(workspace, "assets"), { recursive: true });

  const settled = await mapLimit(script.beats, opts.concurrency ?? 3, async (beat) => {
    try {
      return {
        ok: true as const,
        asset: await acquireBeat(beat, workspace, voiceover, opts.themes?.[beat.id]),
      };
    } catch (e) {
      return { ok: false as const, beatId: beat.id, error: e as Error };
    }
  });

  const failed = settled.filter((r) => !r.ok);
  if (failed.length > 0) {
    const detail = failed
      .map((f) => `beat "${(f as { beatId: string }).beatId}": ${(f as { error: Error }).error.message}`)
      .join("; ");
    throw new Error(`Asset acquisition failed for ${failed.length} beat(s) — ${detail}`);
  }

  const assets = settled.map((r) => (r as { asset: AcquiredAsset }).asset);

  const music =
    opts.music === false
      ? undefined
      : await (async () => {
          const sel = await selectMusic(script.music_mood, script.target_duration_s);
          return {
            path: sel.path,
            name: sel.name,
            loudnessLufs: sel.loudnessLufs,
            license: sel.matchedMood
              ? sel.license
              : `${sel.license ?? "licensed"} (mood "${script.music_mood}" not matched — fallback track)`,
          };
        })();

  // Optional per-beat image overlays (logos, screenshot crops). Acquired after
  // the visuals because they are small and independent; a failure here names
  // its beat and fails the manifest like any other missing asset.
  const overlays = (
    await mapLimit(script.beats, opts.concurrency ?? 3, (beat) =>
      acquireOverlayImage(beat, workspace),
    )
  ).filter((o): o is NonNullable<typeof o> => Boolean(o));

  return AssetManifest.parse({
    run_id: script.run_id,
    assets,
    voiceover,
    overlays,
    music,
  });
}
