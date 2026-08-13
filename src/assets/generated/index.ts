import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { config } from "../../config.js";
import type { GeneratedScene } from "../../shared/schemas.js";
import { buildPage } from "./page.js";
import { verifyGeneratedClip, type ClipVerification } from "./verify.js";
import { probe } from "../../verify/media.js";

const exec = promisify(execFile);

export { verifyGeneratedClip } from "./verify.js";
export type { ClipVerification } from "./verify.js";
export { buildPage } from "./page.js";

export interface RenderSceneOptions {
  /** Validated GeneratedScene (schemas.ts). Content only — timing is ours. */
  spec: GeneratedScene;
  /** The beat's MEASURED voiceover length. The scene fills exactly this. */
  durationS: number;
  /** Absolute path of the .mp4 to write. */
  outPath: string;
  onProgress?: (msg: string) => void;
}

export interface RenderedScene {
  path: string;
  durationS: number;
  width: number;
  height: number;
  fps: number;
  verification: ClipVerification;
}

/** Pre-roll held before the animation starts, and tail held after it ends.
 *  Both are trimmed away; they exist so the cut never clips real motion. */
const PREROLL_S = 0.8;
const TAIL_S = 0.5;

/**
 * Finds where the white pre-roll ends in the raw recording — frame zero of the
 * animation, measured rather than assumed. Chromium's first captured frames
 * arrive 100-400ms after page creation and the lag is not stable between runs,
 * so a wall-clock offset would slice into the animation.
 *
 * Detection is by mean luma per frame, not blackdetect/whitedetect on a
 * threshold of "fully white": the recorder's first frame is often a COMPOSITE
 * of the overlay and the page underneath (measured YAVG 136 on the terminal
 * scene, halfway between the 236 pre-roll and the ~45 scene), so a
 * "99% of pixels are white" test misses it entirely. Anything above 110 is
 * pre-roll; every scene averages well under 70.
 *
 * The pre-roll is white, not black, because these scenes are dark enough that a
 * black pre-roll is indistinguishable from content — an earlier black one made
 * blackdetect report the pre-roll and the first 4.5s of the code scene as a
 * single segment.
 *
 * PLAYWRIGHT'S RECORDER DROPS UNCHANGED FRAMES, so the 800ms hold collapses to
 * a couple of frames in the webm and a static scene would silently compress the
 * whole clip. That is why the pre-roll pulses (page.ts) and why every scene
 * keeps ambient motion running.
 */
const PREROLL_LUMA = 110;

async function prerollEnd(webm: string): Promise<number> {
  const { stderr } = await exec(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", webm,
     "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG",
     "-f", "null", "-"],
    { maxBuffer: 1024 * 1024 * 64 },
  );
  const frames = [...stderr.matchAll(
    // The YAVG line carries an ffmpeg filter prefix, so match across it.
    /pts_time:([\d.]+)[\s\S]{0,120}?lavfi\.signalstats\.YAVG=([\d.eE+-]+)/g,
  )].map((m) => ({ t: Number(m[1]), y: Number(m[2]) }));
  if (frames.length < 4) {
    throw new Error(`Only ${frames.length} frames decoded from ${webm} — nothing usable to trim`);
  }
  if (frames[0]!.y < PREROLL_LUMA) {
    throw new Error(
      `No white pre-roll at the head of ${webm} (first frame mean luma ` +
        `${frames[0]!.y.toFixed(1)}) — the recording did not begin on the ` +
        `pre-roll overlay, so the trim point cannot be located.`,
    );
  }
  const firstScene = frames.find((f) => f.y < PREROLL_LUMA);
  if (!firstScene) {
    throw new Error(`${webm} never leaves the pre-roll — the scene never rendered.`);
  }
  return firstScene.t;
}

/**
 * Renders one generated scene to a 1080x1920 H.264 mp4 of exactly `durationS`.
 *
 * Same output contract as recordScreen() so the timeline builder needs no
 * special case: H.264 in mp4 at the project fps, video only.
 *
 * The clip is verified before it is returned; a scene that renders blank, still
 * or short throws with the real measurements attached rather than reaching the
 * edit (PRD §4a).
 */
export async function renderScene(opts: RenderSceneOptions): Promise<RenderedScene> {
  // Retry once with a much longer tail on a SHORT clip, and only on that.
  //
  // Playwright's recorder runs on wall-clock, so the frames it captures after
  // __start() depend on how much CPU the page actually got. Rendering one
  // scene at a time, a 0.5s tail was ample. Rendering three at once — which is
  // what acquireAssets does, at concurrency 3 — the metric scene came back
  // 3.200s against a 3.584s beat, because three Chromium instances were
  // competing for the compositor. The clip was correct in every way except
  // that it stopped early.
  //
  // Retrying only on shortfall is deliberate: a blank scene, a still scene or
  // an in-page exception are all real defects that a retry would merely
  // reroll, and rerolling a real defect is how a broken clip reaches the edit.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await renderOnce(opts, attempt === 1 ? TAIL_S : TAIL_S * 6);
    } catch (err) {
      const short = err instanceof ShortRenderError;
      if (!short || attempt === 2) throw err;
      opts.onProgress?.(
        `recording came back short (${(err as ShortRenderError).message}); ` +
          `retrying with a ${(TAIL_S * 6).toFixed(1)}s tail`,
      );
    }
  }
  throw new Error("unreachable");
}

/** A recording that stopped early — the one failure worth retrying. */
class ShortRenderError extends Error {}

async function renderOnce(opts: RenderSceneOptions, tailS: number): Promise<RenderedScene> {
  const { spec, durationS, outPath } = opts;
  const say = opts.onProgress ?? (() => {});
  if (!(durationS > 0.5)) {
    throw new Error(`renderScene: durationS must be > 0.5s, got ${durationS}`);
  }

  const outDir = dirname(outPath);
  const rawDir = `${outPath}-raw`;
  await mkdir(outDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });

  const html = await buildPage(spec, durationS);
  say(`generated ${spec.scene} page: ${(html.length / 1024).toFixed(0)} KB`);

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let webmPath = "";

  const browser = await chromium.launch({
    args: [
      // SwiftShader keeps the particles scene rendering on a headless Mac with
      // no GPU access; without it WebGLRenderer construction throws.
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-lcd-text",
      "--force-color-profile=srgb",
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: config.video.width, height: config.video.height },
      deviceScaleFactor: 1,
      recordVideo: {
        dir: rawDir,
        size: { width: config.video.width, height: config.video.height },
      },
    });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction("window.__sceneReady === true", null, { timeout: 20_000 });
    // Fonts must be resolved before frame zero: a scene that starts in a
    // fallback face and reflows mid-typing looks like a bug.
    await page.evaluate("document.fonts.ready");
    await page.waitForTimeout(PREROLL_S * 1000);

    say(`recording ${durationS.toFixed(2)}s of ${spec.scene}`);
    await page.evaluate("window.__start()");
    await page.waitForTimeout((durationS + tailS) * 1000);

    const sceneError = await page.evaluate("window.__sceneError || null");
    if (sceneError) throw new Error(`Scene "${spec.scene}" threw in-page: ${sceneError}`);

    const video = page.video();
    if (!video) throw new Error("Playwright did not attach a video recorder");
    webmPath = join(rawDir, "scene.webm");
    await page.close();
    await context.close();
    await video.saveAs(webmPath);
  } finally {
    await browser.close();
  }

  if (consoleErrors.length || pageErrors.length) {
    throw new Error(
      `Scene "${spec.scene}" produced browser errors — the clip is not ` +
        `trustworthy:\n` +
        [...pageErrors.map((e) => `  pageerror: ${e}`),
         ...consoleErrors.map((e) => `  console.error: ${e}`)].join("\n"),
    );
  }
  if (!(await stat(webmPath)).size) {
    throw new Error(`Playwright wrote an empty recording at ${webmPath}`);
  }

  const start = await prerollEnd(webmPath);
  say(`pre-roll ends at ${start.toFixed(3)}s; trimming ${durationS.toFixed(2)}s from there`);

  // -ss before -i on a webm decodes from the nearest keyframe, and Playwright's
  // webm is sparsely keyframed, so the seek is placed AFTER -i (accurate,
  // decode-and-discard) — the clip length matters more than a second of CPU.
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", webmPath,
    "-ss", start.toFixed(3), "-t", durationS.toFixed(3),
    "-r", String(config.video.fps),
    "-vf", `scale=${config.video.width}:${config.video.height}`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
    outPath,
  ], { maxBuffer: 1024 * 1024 * 16 });

  await rm(rawDir, { recursive: true, force: true });

  // Distinguish "stopped early" from every other defect BEFORE the full
  // verification, so the retry above can tell them apart.
  const producedS = (await probe(outPath)).durationS;
  if (producedS < durationS - 2 / config.video.fps) {
    throw new ShortRenderError(
      `${producedS.toFixed(3)}s of a requested ${durationS.toFixed(3)}s`,
    );
  }

  const verification = await verifyGeneratedClip(outPath, durationS);
  say(`verified: ${verification.checks.map((c) => c.name).join(", ")}`);

  return {
    path: outPath,
    durationS: verification.durationS,
    width: verification.width,
    height: verification.height,
    fps: verification.fps,
    verification,
  };
}
