import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../config.js";

/**
 * Renders a composed project to an mp4 via the HyperFrames CLI.
 *
 * Replaces Palmier's export_project + manage_exports polling. There is no job
 * queue to poll and no application to keep alive: the command runs to
 * completion or fails with a real error.
 *
 * On `--strict`: a lint ERROR switches off the layout and contrast audits, so
 * `check` reports "0 samples" and reads like a clean file while nothing ran.
 * Rendering past a lint error would therefore ship an unaudited video.
 *
 * On quality vs resolution: `--resolution` only supersamples upward by an
 * integer factor, so it cannot make a review iteration cheaper. `--quality
 * draft` does, and it changes encoder settings rather than framing — the
 * Layer-2 vision reviewer sees the same composition either way.
 */
export type RenderQuality = "draft" | "standard" | "high";

export interface RenderOptions {
  projectDir: string;
  outputPath: string;
  quality?: RenderQuality;
  onProgress?: (line: string) => void;
}

export function renderArgs(opts: RenderOptions): string[] {
  return [
    "hyperframes", "render", opts.projectDir,
    "--output", opts.outputPath,
    "--fps", String(config.video.fps),
    "--quality", opts.quality ?? "high",
    "--strict",
  ];
}

export async function render(opts: RenderOptions): Promise<string> {
  // renderArgs() still starts with "hyperframes" (kept for renderArgs.test.ts
  // and for callers that log the args as a human-readable command line) — but
  // the process we actually spawn is `pnpm exec`, not `npx`. `npx` resolves
  // (and if missing, downloads) whatever version npm's registry serves at
  // call time, so the CLI that renders every video was an unpinned, floating
  // dependency. `pnpm exec` runs the version pinned in package.json's
  // devDependencies and installed in this project's node_modules — the same
  // guarantee GSAP_SRC gives the compositor, now given to the renderer too.
  const [cmd, ...args] = renderArgs(opts);
  await new Promise<void>((resolve, reject) => {
    const child = execFile("pnpm", ["exec", cmd!, ...args], { maxBuffer: 64 * 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()));
    child.stderr?.on("data", (d) => opts.onProgress?.(String(d).trimEnd()));
    child.stdout?.on("data", (d) => opts.onProgress?.(String(d).trimEnd()));
  });
  if (!existsSync(opts.outputPath)) {
    throw new Error(`hyperframes render reported success but ${opts.outputPath} does not exist`);
  }
  return opts.outputPath;
}
