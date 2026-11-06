import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { config } from "../../config.js";
import type { GeneratedScene } from "../../shared/schemas.js";
import { buildPage } from "./page.js";
import { verifyGeneratedClip, type ClipVerification } from "./verify.js";


export { verifyGeneratedClip } from "./verify.js";
export type { ClipVerification } from "./verify.js";
export { buildPage } from "./page.js";
import type { SceneTheme } from "./page.js";
export type { SceneTheme };

export interface RenderSceneOptions {
  /** Validated GeneratedScene (schemas.ts). Content only — timing is ours. */
  spec: GeneratedScene;
  /** The beat's MEASURED voiceover length. The scene fills exactly this. */
  durationS: number;
  /** Absolute path of the .mp4 to write. */
  outPath: string;
  onProgress?: (msg: string) => void;
  /** Studio backdrop to render on (see page.ts SceneTheme). */
  theme?: SceneTheme;
}

export interface RenderedScene {
  path: string;
  durationS: number;
  width: number;
  height: number;
  fps: number;
  verification: ClipVerification;
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
  const { spec, durationS, outPath } = opts;
  const say = opts.onProgress ?? (() => {});
  if (!(durationS > 0.5)) {
    throw new Error(`renderScene: durationS must be > 0.5s, got ${durationS}`);
  }
  await mkdir(dirname(outPath), { recursive: true });

  const html = await buildPage(spec, durationS, opts.theme);
  say(`generated ${spec.scene} page: ${(html.length / 1024).toFixed(0)} KB`);

  const fps = config.video.fps;
  const frames = Math.round(durationS * fps);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  // FRAME-STEPPED, not recorded. WebGL here runs on SwiftShader (CPU), and a
  // 1080x1920 lit three.js frame takes far longer than 1/30 s, so Playwright's
  // wall-clock recorder captured a few frames a second and the 3D motion
  // stuttered (2026-11-06). Every scene is a pure function of t, so we set the
  // clock to exactly i/fps, draw, and screenshot — every frame lands, however
  // slow the machine, and the clip is exactly `frames` long by construction.
  const browser = await chromium.launch({
    args: [
      // SwiftShader keeps WebGL working on a headless Mac with no GPU access.
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-lcd-text",
      "--force-color-profile=srgb",
    ],
  });
  const ff = spawn("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-vf", `scale=${config.video.width}:${config.video.height}`,
    // A keyframe every second: HyperFrames seeks into these clips, and x264's
    // default 250-frame GOP made it warn of seek failures / frozen frames.
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-g", String(fps), "-keyint_min", String(fps),
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
    outPath,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let ffErr = "";
  ff.stderr.on("data", (d) => (ffErr += String(d)));
  const ffDone = new Promise<number>((res) => ff.on("close", (code) => res(code ?? 1)));
  try {
    const context = await browser.newContext({
      viewport: { width: config.video.width, height: config.video.height },
      deviceScaleFactor: 1,
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

    // Placement guard: a prop3d page reports where its prop landed. Outside
    // the band = under the captions/counter or over the footnote — fail now,
    // before spending the capture, rather than ship it.
    const fit = (await page.evaluate("window.__fit || null")) as
      | { top: number; bottom: number; width: number; band: { top: number; bottom: number } }
      | null;
    if (fit) {
      const slack = 12;
      if (fit.top < fit.band.top - slack || fit.bottom > fit.band.bottom + slack || fit.width > 0.9 * 1080) {
        throw new Error(
          `Prop placement: the ${spec.scene} prop spans y ${fit.top.toFixed(0)}–${fit.bottom.toFixed(0)}px, ` +
            `${fit.width.toFixed(0)}px wide; it must sit inside y ${fit.band.top}–${fit.band.bottom}px ` +
            `(below the captions/counter/tag, above the footnote) and under 972px wide.`,
        );
      }
      say(`prop fits y ${fit.top.toFixed(0)}–${fit.bottom.toFixed(0)}px (band ${fit.band.top}–${fit.band.bottom})`);
    }

    say(`capturing ${frames} frames (${durationS.toFixed(2)}s) of ${spec.scene}`);
    for (let i = 0; i < frames; i++) {
      await page.evaluate(`window.__seek(${(i / fps).toFixed(6)})`);
      const jpg = await page.screenshot({ type: "jpeg", quality: 92 });
      if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
    }
    const sceneError = await page.evaluate("window.__sceneError || null");
    if (sceneError) throw new Error(`Scene "${spec.scene}" threw in-page: ${sceneError}`);
    await context.close();
  } catch (err) {
    ff.kill("SIGKILL");
    throw err;
  } finally {
    await browser.close();
  }
  ff.stdin.end();
  if ((await ffDone) !== 0) throw new Error(`ffmpeg failed encoding ${outPath}: ${ffErr.trim()}`);

  if (consoleErrors.length || pageErrors.length) {
    throw new Error(
      `Scene "${spec.scene}" produced browser errors — the clip is not ` +
        `trustworthy:\n` +
        [...pageErrors.map((e) => `  pageerror: ${e}`),
         ...consoleErrors.map((e) => `  console.error: ${e}`)].join("\n"),
    );
  }

  // WebGL scenes move continuously by design, so they also get the stutter check.
  const continuousMotion = spec.scene === "prop3d" || spec.scene === "particles";
  const verification = await verifyGeneratedClip(outPath, durationS, { continuousMotion });
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
