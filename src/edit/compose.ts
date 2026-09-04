import { join, extname, basename } from "node:path";
import { rm, mkdir, copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { AssetManifest } from "../shared/schemas.js";
import { framesToSeconds, roundSeconds, dbToGain } from "./units.js";
import {
  FONTS,
  CAPTION_FONT,
  compositionCss,
  titleHtml,
  variantForIndex,
  needsScrim,
  escapeHtml,
  type FontKey,
} from "./styles.js";
import { alignWords, captionsHtml, type WordTiming, type CaptionHighlight } from "./captions.js";
import type { BeatPlan, BuildOverrides } from "./plan-beats.js";

/**
 * The composition writer — the HyperFrames replacement for `build-timeline.ts`.
 *
 * Same assembly ORDER and the same tuned CONSTANTS as the Palmier build (the
 * 2.4x screen-recording push-in, centerX 0.42 / centerY 0.32, the split-shot
 * 1.3x, the -20 dB music duck, the 0.5s/1.5s music fades). What disappears is
 * all the bookkeeping that existed only because Palmier is a stateful desktop
 * app: track indices, import queues, duration polling, the canvas hijack
 * workaround, and the two-layer text hack. In HTML, DOM ORDER IS Z-ORDER, so
 * the footage → scrim → overlay → title → caption stack is correct for free
 * and two text clips can no longer overwrite each other.
 *
 * Timing is SECONDS (never a frame number in a data attribute) and gain is
 * LINEAR (never dB in `data-volume`); both conversions go through units.ts.
 *
 * SHORT ASSETS — SETTLED AT THE TASK 8 PARITY CHECK. When an asset is SHORTER
 * than its beat, `build-timeline.ts` stretched it with `speed = actualFrames /
 * beatFrames`. This module clamps `data-duration` to the asset's real length
 * instead, and originally left the remainder uncovered — which the first real
 * render showed to be 4.6s of BLACK across 5 of 6 beats, title and caption
 * floating on nothing while the VO kept talking. `holdsForBeat` now covers
 * every uncovered interval with a held still of the last frame shown. Beat
 * boundaries are untouched by any of this — they are set by the VO.
 *
 * That also closes what were deferred items (a) and (b): the mid-beat gap a
 * head trim opens on a split beat, and the `take`-vs-frames divergence in
 * `splitAt` placement. Both were gaps, and gaps are now filled generically.
 *
 * REMAINING DIFFERENCE FROM PALMIER:
 *   (c) Captions render ABOVE titles (DOM order), inverted from Palmier, where
 *       the title tracks were added after the caption track. It matters only
 *       where a tall title reaches down to ~75% and meets the caption band at
 *       72%; with titles centred at 24% (styles.ts) nothing comes close.
 */

const execFileAsync = promisify(execFile);

const { fps, width: CANVAS_W, height: CANVAS_H } = config.video;

/**
 * GSAP is NOT pre-injected by the renderer — the official minimal composition
 * loads it itself, and without this tag the inline timeline script below is a
 * ReferenceError at render time on every project. Pinned, so a floating
 * version can never change a render.
 */
const GSAP_SRC = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";

/** Every HyperFrames id in this project hangs off this one composition id. */
export const COMPOSITION_ID = "kernelshorts";

/** Screen recordings: the push-in tuned in build-timeline.ts §6. Sites render
 *  their full-width layout even in a mobile viewport, so at 1080 wide the body
 *  text is unreadable; 1.55x measured still too small on a real export, and
 *  2.4x is where Hacker News headlines become legible. The bias up and left
 *  (0.42 / 0.32) keeps the top of the page — where the content is — in frame. */
const SCREENREC_ZOOM = 2.4;
const SCREENREC_CENTER_X = 0.42;
const SCREENREC_CENTER_Y = 0.32;
/** The second shot of a split beat pushes in, so the cut reads as a change of
 *  framing rather than a jump within the same frame. */
const SPLIT_PUSH_IN = 1.3;
/** build-timeline.ts §7: fades on the music bed, in seconds. */
const MUSIC_FADE_IN_S = 0.5;
const MUSIC_FADE_OUT_S = 1.5;
/** Music bed level under the VO. Tuned by ear: -16 still sat too loud. */
const DEFAULT_MUSIC_DUCK_DB = -20;

/**
 * The font files behind the families named in styles.ts. Installed to
 * ~/Library/Fonts and kept in vault/fonts/ — see the licence notes on FONTS.
 * Filenames are constants so `composeHtml` stays pure; `compose` is the only
 * thing that touches the disk, and it THROWS when a face is missing (PRD §0:
 * no fallback to a system font, ever — a substituted face silently changes
 * every measured title size).
 */
const FONT_FILES: Record<FontKey | "caption", { family: string; file: string }> = {
  coolvetica: { family: FONTS.coolvetica, file: "CoolveticaRg.otf" },
  herkey: { family: FONTS.herkey, file: "HerkeyTTF.ttf" },
  melodrame: { family: FONTS.melodrame, file: "RelationshipOfMelodrame.ttf" },
  caption: { family: CAPTION_FONT, file: "CoolveticaRgIt.otf" },
};

const FONT_SEARCH_DIRS = [
  join(process.cwd(), "vault", "fonts"),
  join(homedir(), "Library", "Fonts"),
  "/Library/Fonts",
];

/** `format()` hint for @font-face; wrong hints make the face silently unused. */
function fontFormat(file: string): string {
  return extname(file).toLowerCase() === ".otf" ? "opentype" : "truetype";
}

/** @font-face rules pointing at the fonts staged into assets/fonts/. */
function fontFacesCss(): string {
  return Object.values(FONT_FILES)
    .map(
      ({ family, file }) =>
        `@font-face { font-family: "${family}"; src: url("assets/fonts/${file}") format("${fontFormat(file)}"); }`,
    )
    .join("\n    ");
}

/**
 * Writes a single frame of `source` at `atS` to `outPath` as a PNG.
 *
 * `-accurate_seek` with `-ss` BEFORE `-i` is the fast, frame-exact form; the
 * still is the picture a held interval freezes on. Throws on failure and on a
 * missing output — a hold with no image is a black frame, which is exactly
 * what the hold exists to prevent, so it must never pass silently.
 */
async function extractStill(source: string, atS: number, outPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-v", "error", "-y",
    "-accurate_seek", "-ss", String(atS),
    "-i", source,
    "-frames:v", "1", "-update", "1",
    outPath,
  ]);
  if (!existsSync(outPath)) {
    throw new Error(
      `ffmpeg reported success but produced no held frame at ${atS}s of "${source}" (${outPath})`,
    );
  }
}

/** Locates an installed font file, or throws. No system-font fallback. */
function resolveFontFile(file: string): string {
  for (const dir of FONT_SEARCH_DIRS) {
    const direct = join(dir, file);
    if (existsSync(direct)) return direct;
    // vault/fonts keeps each face in its own folder alongside a LICENSE.md.
    const nested = join(dir, basename(file, extname(file)), file);
    if (existsSync(nested)) return nested;
  }
  throw new Error(
    `Font file "${file}" not found in any of: ${FONT_SEARCH_DIRS.join(", ")}. ` +
      `Install it (vault/fonts or ~/Library/Fonts) — there is no system-font fallback.`,
  );
}

/**
 * Guards the recursive remove in `compose()`.
 *
 * Carried over from build-timeline.ts's `removeStaleProject`: the run id names
 * a directory that is then deleted recursively, so a malformed one must never
 * be able to reach outside the project directory or delete a project a human
 * made. Deliberately narrow — reject and halt, never sanitize.
 */
export function assertSafeRunId(runId: string): void {
  if (runId.includes("/") || runId.includes("..") || runId.trim() === "") {
    throw new Error(`Refusing to compose a project for unsafe run id "${runId}"`);
  }
}

export interface ComposeOptions {
  plan: BeatPlan[];
  manifest: AssetManifest;
  projectDir: string;
  runId: string;
  /** Music bed level under the VO, in dB. Converted to linear gain here. */
  musicDuckDb?: number;
  overrides?: BuildOverrides;
  /** beatId -> word timings measured from that beat's own VO file. */
  wordTimings?: Map<string, WordTiming[]>;
  /** Active-word caption treatment: yellow word ("pop") or red plate ("block"). */
  captionHighlight?: CaptionHighlight;
}

export interface ComposeResult {
  projectDir: string;
  indexPath: string;
  totalSeconds: number;
}

/** Where a beat's staged files live, relative to index.html. */
const visualRel = (p: BeatPlan): string => `assets/visuals/${p.beatId}${extname(p.asset.path)}`;
const voRel = (p: BeatPlan): string => `assets/vo/${p.beatId}${extname(p.voPath)}`;
const musicRel = (m: { path: string }): string => `assets/music/bed${extname(m.path)}`;
const holdRel = (h: { id: string }): string => `assets/holds/${h.id}.png`;

/** Percentages and scale factors — not seconds, so not roundSeconds. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

interface Shot {
  id: string;
  startS: number;
  durationS: number;
  mediaStartS: number;
  zoom: number;
  centerX: number;
  centerY: number;
}

/**
 * A held still covering an interval of a beat that no shot reaches.
 *
 * `mediaAtS` is the source time whose frame is frozen: the last frame the
 * viewer saw before the gap opened, so the picture stops rather than cuts.
 */
interface Hold {
  id: string;
  beatId: string;
  startS: number;
  durationS: number;
  mediaAtS: number;
  zoom: number;
  centerX: number;
  centerY: number;
}

/**
 * Gaps shorter than half a frame are float noise from the seconds-space
 * arithmetic above, not real uncovered time. Anything a viewer could see is
 * at least one frame.
 */
const MIN_HOLD_S = 0.5 / fps;

/**
 * Every interval of a beat that its shots do not cover, as a held still.
 *
 * THIS IS THE FIX FOR THE TASK 8 PARITY FINDING. `shotsForBeat` clamps a shot
 * to the asset's real length, so an asset shorter than its beat used to leave
 * `#root`'s black background showing with the title and caption floating on
 * nothing while the VO kept talking — 4.6s of it across 5 of the 6 beats in
 * run 2026-08-18, including a 3.07s hole on `new_features`. Palmier stretched
 * the asset with `speed` instead; black is strictly worse than either.
 *
 * The freeze/hold recipe in the HyperFrames docs is a still `<img>` that owns
 * its hold duration, and it explicitly supports a final-source-frame hold, so
 * that is what this emits — a PNG extracted at the source time where the
 * picture ran out. `data-playback-rate` (a documented constant retime,
 * normalized 0.1..5) would also have been available and would reproduce
 * Palmier's stretch more literally; a hold was chosen because it is
 * frame-exact and cannot drift, and because these assets are static or
 * slow-scrolling, where a hold is close to invisible.
 *
 * Computed from the shot list rather than from `take` on purpose: it also
 * closes the mid-beat gap a head trim opens on a split beat (deferred item (a)
 * in this module's header), because that gap is an uncovered interval like any
 * other.
 */
function holdsForBeat(p: BeatPlan, shots: Shot[]): Hold[] {
  const beatStartS = framesToSeconds(p.startFrame);
  const beatEndS = framesToSeconds(p.endFrame);
  const ordered = [...shots].sort((a, b) => a.startS - b.startS);

  const holds: Hold[] = [];
  let cursorS = beatStartS;
  // The source time to freeze at: the media time the previous shot reached.
  // Before the first shot there is no previous frame, so the first shot's own
  // opening frame stands in.
  let mediaAtS = ordered[0]?.mediaStartS ?? 0;

  const push = (untilS: number): void => {
    const durationS = roundSeconds(untilS - cursorS);
    if (durationS < MIN_HOLD_S) return;
    holds.push({
      id: `hold-${p.beatId}-${holds.length}`,
      beatId: p.beatId,
      startS: roundSeconds(cursorS),
      durationS,
      mediaAtS: roundSeconds(Math.max(0, mediaAtS)),
      zoom: ordered[0]?.zoom ?? 1,
      centerX: ordered[0]?.centerX ?? 0.5,
      centerY: ordered[0]?.centerY ?? 0.5,
    });
  };

  for (const shot of ordered) {
    push(shot.startS);
    const shotEndS = roundSeconds(shot.startS + shot.durationS);
    if (shotEndS > cursorS) cursorS = shotEndS;
    mediaAtS = roundSeconds(shot.mediaStartS + shot.durationS);
  }
  push(beatEndS);

  return holds;
}

/** Exposed for tests: the intervals of a beat no shot and no hold covers. */
export function uncoveredIntervals(
  p: BeatPlan,
  overrides?: BuildOverrides,
): Array<{ startS: number; endS: number }> {
  const shots = shotsForBeat(p, overrides);
  const covers = [
    ...shots.map((s) => ({ startS: s.startS, endS: roundSeconds(s.startS + s.durationS) })),
    ...holdsForBeat(p, shots).map((hd) => ({
      startS: hd.startS,
      endS: roundSeconds(hd.startS + hd.durationS),
    })),
  ].sort((a, b) => a.startS - b.startS);

  const gaps: Array<{ startS: number; endS: number }> = [];
  let cursorS = framesToSeconds(p.startFrame);
  for (const c of covers) {
    if (c.startS - cursorS >= MIN_HOLD_S) gaps.push({ startS: cursorS, endS: c.startS });
    if (c.endS > cursorS) cursorS = c.endS;
  }
  const beatEndS = framesToSeconds(p.endFrame);
  if (beatEndS - cursorS >= MIN_HOLD_S) gaps.push({ startS: cursorS, endS: beatEndS });
  return gaps;
}

/**
 * The visual shot(s) for one beat, already in seconds.
 *
 * A beat is normally one shot. `splitAt` cuts it into two from the same
 * source, continuing THROUGH the cut (the second shot's media start is where
 * the first ended) so motion does not jump backwards.
 */
function shotsForBeat(p: BeatPlan, overrides: BuildOverrides | undefined): Shot[] {
  const beat = overrides?.beats?.[p.beatId];
  const isScreenRec = p.asset.kind === "screenrec";
  const zoom = beat?.zoom ?? (isScreenRec ? SCREENREC_ZOOM : 1);
  const centerX = isScreenRec ? SCREENREC_CENTER_X : 0.5;
  const centerY = beat?.centerY ?? (isScreenRec ? SCREENREC_CENTER_Y : 0.5);

  const beatStartS = framesToSeconds(p.startFrame);
  const beatSeconds = framesToSeconds(p.endFrame - p.startFrame);
  // Clamp to what the asset actually has (see the module comment: Palmier
  // stretched instead).
  const available = p.asset.durationS ?? beatSeconds;
  const take = Math.min(available, beatSeconds);

  // Review-loop trims tighten a beat's visual WITHOUT moving the beat
  // boundary — boundaries are fixed by the VO and must not drift.
  const trimStartS = framesToSeconds(beat?.trimStartFrames ?? 0);
  const trimEndS = framesToSeconds(beat?.trimEndFrames ?? 0);

  const splitAt = beat?.splitAt;
  if (splitAt !== undefined && splitAt > 0.15 && splitAt < 0.85 && take > 1.5) {
    const cutStartS = framesToSeconds(
      p.startFrame + Math.round((p.endFrame - p.startFrame) * splitAt),
    );
    const cutMediaS = roundSeconds(take * splitAt);
    return [
      {
        id: `video-${p.beatId}-a`,
        startS: beatStartS,
        durationS: roundSeconds(cutMediaS - trimStartS),
        mediaStartS: trimStartS,
        zoom,
        centerX,
        centerY,
      },
      {
        id: `video-${p.beatId}-b`,
        startS: cutStartS,
        durationS: roundSeconds(take - cutMediaS - trimEndS),
        mediaStartS: cutMediaS,
        zoom: round6(zoom * SPLIT_PUSH_IN),
        centerX,
        centerY,
      },
    ];
  }

  return [
    {
      id: `video-${p.beatId}`,
      startS: beatStartS,
      durationS: roundSeconds(take - trimStartS - trimEndS),
      mediaStartS: trimStartS,
      zoom,
      centerX,
      centerY,
    },
  ];
}

/** Exposed for tests: builds the HTML without touching the filesystem. */
export function composeHtml(opts: ComposeOptions): string {
  const { plan, manifest, overrides } = opts;
  const totalFrames = plan.at(-1)?.endFrame ?? 0;
  if (totalFrames === 0) throw new Error("Empty beat plan — nothing to compose");
  const totalSeconds = framesToSeconds(totalFrames);
  const musicGain = dbToGain(opts.musicDuckDb ?? DEFAULT_MUSIC_DUCK_DB);

  const parts: string[] = [];

  // 1. Visuals. Each <video> is a DIRECT child of the root carrying its own
  //    timing: a <video data-start> nested in another timed element lints as
  //    video_nested_in_timed_element and really does show the wrong source
  //    frames and then vanish mid-slot. `muted` + `playsinline`, never
  //    `crossorigin`, and no <audio> partner — the VO carries the sound, which
  //    is what `volumeDb: -60` on the nested clip did under Palmier.
  for (const p of plan) {
    const src = escapeHtml(visualRel(p));
    const shots = shotsForBeat(p, overrides);
    const framing = (s: { zoom: number; centerX: number; centerY: number }): string =>
      `transform: scale(${s.zoom}); ` +
      `object-position: ${round6(s.centerX * 100)}% ${round6(s.centerY * 100)}%`;

    for (const shot of shots) {
      parts.push(
        `<video class="beat-video clip" id="${escapeHtml(shot.id)}" ` +
          `data-start="${shot.startS}" data-duration="${shot.durationS}" ` +
          `data-media-start="${shot.mediaStartS}" ` +
          `style="${framing(shot)}" src="${src}" muted playsinline></video>`,
      );
    }
    // Held stills covering whatever the shots do not reach. Same framing as
    // the shot they continue, so the picture stops rather than jumps.
    for (const hold of holdsForBeat(p, shots)) {
      parts.push(
        `<img class="beat-video clip" id="${escapeHtml(hold.id)}" ` +
          `data-start="${hold.startS}" data-duration="${hold.durationS}" ` +
          `style="${framing(hold)}" src="${escapeHtml(holdRel(hold))}" alt="" />`,
      );
    }
  }

  // 2. Scrim, above the footage and below the text — pure DOM order now, where
  //    Palmier needed a track above the visuals and below the add_texts tracks.
  //    A gradient div, not an imported PNG: scrim.ts's ffmpeg render existed
  //    only because Palmier's matte source is flat colour.
  for (const [i, p] of plan.entries()) {
    const forced = overrides?.beats?.[p.beatId]?.treatment;
    if (!p.onScreenText || forced === "none") continue;
    if (!needsScrim(i, forced)) continue;
    parts.push(
      `<div class="clip scrim" id="scrim-${escapeHtml(p.beatId)}" ` +
        `data-start="${framesToSeconds(p.startFrame)}" ` +
        `data-duration="${framesToSeconds(p.endFrame - p.startFrame)}"></div>`,
    );
  }

  // 3. Image overlays — a logo or screenshot crop instead of a text title.
  //    Above the scrim, below any title. `scale` is a fraction of canvas
  //    width and `centerY` a fraction of canvas height, exactly as under
  //    Palmier; `inset: auto` releases the .clip full-bleed box first.
  for (const overlay of manifest.overlays ?? []) {
    const beat = plan.find((p) => p.beatId === overlay.beat_id);
    if (!beat) continue;
    parts.push(
      `<img class="clip overlay" id="overlay-${escapeHtml(overlay.beat_id)}" ` +
        `data-start="${framesToSeconds(beat.startFrame)}" ` +
        `data-duration="${framesToSeconds(beat.endFrame - beat.startFrame)}" ` +
        `style="inset: auto; left: 50%; top: ${round6(overlay.centerY * 100)}%; ` +
        `width: ${round6(overlay.scale * 100)}%; height: auto; ` +
        `transform: translate(-50%, -50%);" ` +
        `src="assets/overlays/${escapeHtml(overlay.beat_id)}.png" alt="" />`,
    );
  }

  // 4. Titles. The variant (font AND treatment) rotates per beat so one short
  //    does not repeat a single look; a forced treatment overrides only the
  //    treatment, never the font.
  for (const [i, p] of plan.entries()) {
    const forced = overrides?.beats?.[p.beatId]?.treatment;
    parts.push(
      titleHtml({
        beatId: p.beatId,
        text: p.onScreenText,
        startS: framesToSeconds(p.startFrame),
        durationS: framesToSeconds(p.endFrame - p.startFrame),
        variant: variantForIndex(i, forced),
      }),
    );
  }

  // 5. Captions, on top of everything visual. The words come from the script
  //    (which produced the audio); only the timings come from the transcriber.
  for (const p of plan) {
    const words = alignWords(p.voText, opts.wordTimings?.get(p.beatId) ?? [], p.voDurationS);
    if (words.length === 0) continue;
    parts.push(
      captionsHtml({
        beatId: p.beatId,
        startFrame: p.startFrame,
        words,
        centerY: overrides?.captionCenterY,
        fontSize: overrides?.captionFontSize,
        highlight: opts.captionHighlight,
      }),
    );
  }

  // 6. Voiceover. EVERY <audio> needs an id — the mixer selects
  //    `audio[id][src]`, and an id-less element is never mixed, so the render
  //    comes out silent with no error at all.
  for (const p of plan) {
    parts.push(
      `<audio id="vo-${escapeHtml(p.beatId)}" ` +
        `data-start="${framesToSeconds(p.startFrame)}" ` +
        `data-duration="${roundSeconds(p.voDurationS)}" data-volume="1" ` +
        `src="${escapeHtml(voRel(p))}"></audio>`,
    );
  }

  // 7. Music bed, spanning the whole composition, ducked under the VO.
  //    data-volume is LINEAR gain: -20 dB is 0.1, not "-20".
  if (manifest.music) {
    parts.push(
      `<audio id="music" data-start="0" data-duration="${totalSeconds}" ` +
        `data-volume="${musicGain}" src="${escapeHtml(musicRel(manifest.music))}"></audio>`,
    );
  }

  // 8. Exactly one paused timeline, registered under the composition id AFTER
  //    it is fully built. Render length comes from the root's data-duration,
  //    not from this timeline's length.
  //
  //    The fades tween `volume` rather than swapping data-volume. A tween's
  //    values REPLACE the data-volume baseline rather than scaling it, so the
  //    full-level target here must be the DUCKED gain — tweening to 1 would
  //    undo the duck and trip audio_volume_tween_overrides_gain.
  const fadeOutStart = roundSeconds(Math.max(0, totalSeconds - MUSIC_FADE_OUT_S));
  const script = [
    `window.__timelines = window.__timelines || {};`,
    `const tl = gsap.timeline({ paused: true });`,
    manifest.music
      ? `const music = document.getElementById("music");\n` +
        `      tl.fromTo(music, { volume: 0 }, { volume: ${musicGain}, duration: ${MUSIC_FADE_IN_S}, ease: "none" }, 0);\n` +
        `      tl.to(music, { volume: 0, duration: ${MUSIC_FADE_OUT_S}, ease: "none" }, ${fadeOutStart});`
      : `// no music bed in this manifest — nothing to fade.`,
    `window.__timelines["${COMPOSITION_ID}"] = tl;`,
  ].join("\n      ");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script src="${GSAP_SRC}"></script>
    <title>${escapeHtml(opts.runId)}</title>
    <style>${compositionCss({ width: CANVAS_W, height: CANVAS_H, fontFaces: fontFacesCss() })}</style>
  </head>
  <body>
    <div id="root" data-composition-id="${COMPOSITION_ID}" data-width="${CANVAS_W}" data-height="${CANVAS_H}" data-fps="${fps}" data-duration="${totalSeconds}">
${parts.filter(Boolean).map((h) => `      ${h}`).join("\n")}
    </div>
    <script>
      ${script}
    </script>
  </body>
</html>
`;
}

/**
 * Writes a renderable project directory: every asset staged under
 * `assets/` with a beat-keyed name (the staging idea is kept from
 * build-timeline.ts because it makes the beat↔file mapping exact; the import
 * queue and duration polling around it were Palmier races and are gone), plus
 * index.html.
 */
export async function compose(opts: ComposeOptions): Promise<ComposeResult> {
  const { plan, manifest, projectDir } = opts;
  const totalFrames = plan.at(-1)?.endFrame ?? 0;
  if (totalFrames === 0) throw new Error("Empty beat plan — nothing to compose");
  assertSafeRunId(opts.runId);
  if (projectDir.trim() === "" || projectDir.trim() === "/") {
    throw new Error(`Refusing to compose into project directory "${projectDir}"`);
  }

  // Resolve fonts BEFORE writing anything, so a missing face fails the run
  // rather than producing a project that renders in the wrong typeface.
  const fontSources = Object.values(FONT_FILES).map(({ file }) => ({
    file,
    source: resolveFontFile(file),
  }));

  await rm(projectDir, { recursive: true, force: true });
  for (const sub of ["visuals", "vo", "music", "overlays", "fonts", "holds"]) {
    await mkdir(join(projectDir, "assets", sub), { recursive: true });
  }

  for (const p of plan) {
    await copyFile(p.asset.path, join(projectDir, visualRel(p)));
    await copyFile(p.voPath, join(projectDir, voRel(p)));

    // Extract the still behind every held interval. The frame is pulled one
    // frame BEFORE the media time the shot reached, because that time is the
    // exclusive end of the shot — seeking exactly to it can land past the
    // last decodable frame and yield nothing.
    for (const hold of holdsForBeat(p, shotsForBeat(p, opts.overrides))) {
      const at = Math.max(0, roundSeconds(hold.mediaAtS - 1 / fps));
      await extractStill(p.asset.path, at, join(projectDir, holdRel(hold)));
    }
  }
  if (manifest.music) {
    await copyFile(manifest.music.path, join(projectDir, musicRel(manifest.music)));
  }
  for (const overlay of manifest.overlays ?? []) {
    await copyFile(overlay.path, join(projectDir, "assets", "overlays", `${overlay.beat_id}.png`));
  }
  for (const { file, source } of fontSources) {
    await copyFile(source, join(projectDir, "assets", "fonts", file));
  }

  const indexPath = join(projectDir, "index.html");
  await writeFile(indexPath, composeHtml(opts), "utf8");

  return { projectDir, indexPath, totalSeconds: framesToSeconds(totalFrames) };
}

export type { FontKey };
