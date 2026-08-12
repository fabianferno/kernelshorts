import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { z } from "zod";
import { config } from "../config.js";
import { AcquiredAsset, type ScreenRecSpec as ScreenRecSpecType } from "../shared/schemas.js";
import { probeMedia } from "./ffprobe.js";

const exec = promisify(execFile);

export type ScreenRecSpec = z.infer<typeof ScreenRecSpecType>;

// ─── Scripted actions (PRD §3.8 / §4) ───────────────────────────────────────

export type Action =
  | { kind: "goto" }
  | { kind: "click"; selector: string }
  | { kind: "scroll"; pixels: number }
  | { kind: "wait"; ms: number }
  | { kind: "hover"; selector: string }
  | { kind: "type"; selector: string; text: string };

/**
 * Parses one scripted action. An unrecognised verb THROWS: silently skipping it
 * would produce a recording that doesn't show what the script promised, and the
 * beat's visual would be wrong with no signal (PRD §0).
 */
export function parseAction(raw: string): Action {
  const trimmed = raw.trim();
  const spaceAt = trimmed.indexOf(" ");
  const verb = (spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt)).toLowerCase();
  const rest = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1).trim();

  switch (verb) {
    case "goto":
      return { kind: "goto" };
    case "click":
      if (!rest) throw new Error(`click requires a selector: "${raw}"`);
      return { kind: "click", selector: rest };
    case "hover":
      if (!rest) throw new Error(`hover requires a selector: "${raw}"`);
      return { kind: "hover", selector: rest };
    case "scroll": {
      const px = Number(rest);
      if (!rest || !Number.isFinite(px)) {
        throw new Error(`scroll requires a pixel amount: "${raw}"`);
      }
      return { kind: "scroll", pixels: px };
    }
    case "wait": {
      const ms = Number(rest);
      if (!rest || !Number.isFinite(ms) || ms < 0) {
        throw new Error(`wait requires a millisecond amount: "${raw}"`);
      }
      return { kind: "wait", ms };
    }
    case "type": {
      const sep = rest.indexOf(" ");
      if (sep === -1) throw new Error(`type requires a selector and text: "${raw}"`);
      return {
        kind: "type",
        selector: rest.slice(0, sep),
        text: rest.slice(sep + 1),
      };
    }
    default:
      throw new Error(
        `Unknown screenrec action "${raw}". Supported: goto, click <sel>, ` +
          `scroll <px>, wait <ms>, hover <sel>, type <sel> <text>.`,
      );
  }
}

export type Viewport = { width: number; height: number; isMobile: boolean };

/** mobile → native vertical, fills the 9:16 frame. desktop → wide, cropped and
 *  panned in the edit (Ken Burns over dashboards, PRD §4). */
export function viewportFor(v: ScreenRecSpec["viewport"]): Viewport {
  return v === "mobile"
    ? { width: config.video.width, height: config.video.height, isMobile: true }
    : { width: 1920, height: 1080, isMobile: false };
}

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** A jump-cut scroll looks terrible in a short (PRD brief): ease the page down
 *  over ~1s of real animation frames so the recording captures the motion. */
async function smoothScroll(page: Page, pixels: number): Promise<void> {
  // Passed as a source string, not a TS closure: tsx/esbuild rewrites closures
  // with a `__name` helper that does not exist inside the page, which throws a
  // ReferenceError at evaluate time (hit for real during the M1 spike).
  await page.evaluate(`
    new Promise((resolve) => {
      const px = ${pixels};
      const durationMs = 1000;
      const start = window.scrollY;
      const t0 = performance.now();
      function step(now) {
        const t = Math.min(1, (now - t0) / durationMs);
        // easeInOutQuad — no hard start/stop at either end.
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        window.scrollTo(0, start + px * eased);
        if (t < 1) requestAnimationFrame(step); else resolve(null);
      }
      requestAnimationFrame(step);
    })
  `);
}

async function runAction(page: Page, action: Action, spec: ScreenRecSpec): Promise<void> {
  switch (action.kind) {
    case "goto":
      await page.goto(spec.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(800);
      return;
    case "click":
      await page.click(action.selector, { timeout: 10_000 });
      await page.waitForTimeout(600);
      return;
    case "hover":
      await page.hover(action.selector, { timeout: 10_000 });
      await page.waitForTimeout(600);
      return;
    case "scroll":
      await smoothScroll(page, action.pixels);
      await page.waitForTimeout(400);
      return;
    case "wait":
      await page.waitForTimeout(action.ms);
      return;
    case "type":
      await page.fill(action.selector, "", { timeout: 10_000 });
      await page.type(action.selector, action.text, { delay: 70 });
      await page.waitForTimeout(400);
      return;
  }
}

/**
 * Playwright writes .webm. Palmier REJECTS webm (M0 §3), and mixed fps sources
 * are placed without conforming (M0 "Other notes"), so transcode to H.264 MP4
 * at the project fps before the file is ever handed to the editor.
 */
async function transcodeToMp4(webm: string, mp4: string): Promise<void> {
  await exec(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", webm,
      "-r", String(config.video.fps),
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      mp4,
    ],
    { maxBuffer: 1024 * 1024 * 16 },
  );
}

export type RecordOptions = {
  /** Absolute run workspace directory; the mp4 lands in <workspace>/assets. */
  workspace: string;
  beatId: string;
  /** Hard cap so a hung page can't record forever. */
  maxDurationS?: number;
};

/**
 * Records a real browser session and returns a validated AcquiredAsset whose
 * duration/dimensions are ffprobe-measured. There is no blank-video fallback:
 * a page that won't load or a selector that isn't there fails the beat loudly.
 */
export async function recordScreen(
  spec: ScreenRecSpec,
  opts: RecordOptions,
): Promise<AcquiredAsset> {
  const actions = spec.actions.map(parseAction);
  const viewport = viewportFor(spec.viewport);
  const outDir = join(opts.workspace, "assets");
  const rawDir = join(outDir, `${opts.beatId}-raw`);
  await mkdir(rawDir, { recursive: true });

  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  let webmPath = "";
  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      isMobile: viewport.isMobile,
      hasTouch: viewport.isMobile,
      userAgent: viewport.isMobile ? MOBILE_UA : undefined,
      recordVideo: { dir: rawDir, size: { width: viewport.width, height: viewport.height } },
    });
    const page = await context.newPage();

    // "goto" is the documented first action, but a script that omits it still
    // needs the page loaded before anything else can be clicked.
    if (!actions.some((a) => a.kind === "goto")) {
      await runAction(page, { kind: "goto" }, spec).catch((e: unknown) => {
        throw new Error(
          `Beat "${opts.beatId}": failed to load ${spec.url} — ${(e as Error).message}`,
        );
      });
    }

    for (const [i, action] of actions.entries()) {
      try {
        await runAction(page, action, spec);
      } catch (e) {
        throw new Error(
          `Beat "${opts.beatId}": screenrec action ${i + 1} ("${spec.actions[i]}") failed ` +
            `on ${spec.url} — ${(e as Error).message}`,
        );
      }
    }
    await page.waitForTimeout(500);
    const video = page.video();
    if (!video) {
      throw new Error(`Beat "${opts.beatId}": Playwright did not attach a video recorder`);
    }
    // saveAs() waits for the recording to be fully flushed. Reading the raw dir
    // after context.close() can catch a half-written EBML header (hit for real).
    webmPath = join(rawDir, "recording.webm");
    await page.close();
    await context.close();
    await video.saveAs(webmPath);
  } finally {
    await browser.close();
  }

  if (!(await stat(webmPath)).size) {
    throw new Error(`Beat "${opts.beatId}": Playwright wrote an empty recording at ${webmPath}`);
  }

  const mp4Path = join(outDir, `${opts.beatId}-screenrec.mp4`);
  await transcodeToMp4(webmPath, mp4Path);
  await rm(rawDir, { recursive: true, force: true });

  const info = await probeMedia(mp4Path);
  if (!info.width || !info.height || info.durationS === undefined) {
    throw new Error(
      `Beat "${opts.beatId}": transcoded file ${mp4Path} has no usable video stream`,
    );
  }
  if (opts.maxDurationS && info.durationS > opts.maxDurationS * 4) {
    throw new Error(
      `Beat "${opts.beatId}": recording ran ${info.durationS.toFixed(1)}s, far past the ` +
        `${opts.maxDurationS}s beat budget — the page likely hung.`,
    );
  }

  return AcquiredAsset.parse({
    beat_id: opts.beatId,
    kind: "screenrec",
    path: mp4Path,
    durationS: info.durationS,
    width: info.width,
    height: info.height,
    fps: info.fps,
    sourceUrl: spec.url,
    license: {
      provider: "self-recorded",
      url: spec.url,
      attribution: `Screen recording of ${spec.url}`,
    },
  });
}
