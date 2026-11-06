import { copyFile, mkdir, writeFile } from "node:fs/promises";
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
   * the classic dark scene look.
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
async function acquireStill(
  source: string,
  workspace: string,
  beatId: string,
): Promise<AcquiredAsset> {
  const outDir = join(workspace, "assets");
  await mkdir(outDir, { recursive: true });

  let dest: string;
  let sourceUrl: string | undefined;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`still download failed: ${res.status} ${source}`);
    const ext = extname(new URL(source).pathname) || ".jpg";
    dest = join(outDir, `${beatId}-still${ext}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    sourceUrl = source;
  } else {
    if (!isAbsolute(source)) throw new Error(`still source must be absolute or https: ${source}`);
    if (!existsSync(source)) throw new Error(`still source does not exist: ${source}`);
    dest = join(outDir, `${beatId}-${basename(source)}`);
    if (dest !== source) await copyFile(source, dest);
  }

  const info = await probeMedia(dest);
  return AcquiredAsset.parse({
    beat_id: beatId,
    kind: "still",
    path: dest,
    durationS: undefined,
    width: info.width,
    height: info.height,
    sourceUrl,
    license: {
      provider: sourceUrl ? "external-still" : "local",
      url: sourceUrl,
      attribution: sourceUrl ?? `Local still ${basename(source)}`,
    },
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
      return acquireStill(beat.visual.source, workspace, beat.id);
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
