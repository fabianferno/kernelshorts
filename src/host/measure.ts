import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const exec = promisify(execFile);

/**
 * Geometry of one drawn pose, measured from the images themselves:
 *
 *  - `headTop`: first row of the character (alpha bbox top).
 *  - `mouth`: the box where the closed and open drawings DIFFER inside the
 *    head region. The two are generated as an edit of one another, so the only
 *    real difference is the mouth (SSIM ≈ 0.98); a hair of JPEG noise is
 *    rejected by the threshold and by taking percentiles, not min/max.
 *
 * The compositor uses this to (1) scale/align every pose so the head stays the
 * same size and in the same place across swaps, and (2) mask the open image
 * down to just the mouth, so a flap moves the mouth and nothing else.
 */
export const PoseMeta = z.object({
  width: z.number(),
  height: z.number(),
  headTop: z.number(),
  mouth: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
});
export type PoseMeta = z.infer<typeof PoseMeta>;

async function rgba(path: string): Promise<{ w: number; h: number; px: Buffer }> {
  const { stdout: dims } = await exec("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path,
  ]);
  const [w, h] = dims.trim().split(",").map(Number) as [number, number];
  const { stdout } = await exec(
    "ffmpeg",
    ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
    { encoding: "buffer", maxBuffer: w * h * 4 + 1024 },
  );
  return { w, h, px: stdout as unknown as Buffer };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))]!;
}

export async function measurePose(closedPng: string, openPng: string): Promise<PoseMeta> {
  const a = await rgba(closedPng);
  const b = await rgba(openPng);
  if (a.w !== b.w || a.h !== b.h) throw new Error(`pose pair size mismatch: ${closedPng} vs ${openPng}`);
  const { w, h } = a;

  let headTop = -1;
  for (let y = 0; y < h && headTop < 0; y++) {
    for (let x = 0; x < w; x++) if (a.px[(y * w + x) * 4 + 3]! > 128) { headTop = y; break; }
  }
  if (headTop < 0) throw new Error(`${closedPng} is fully transparent`);

  // Search for the mouth only in the head band: from the head top down ~40% of
  // the image. Hands near the face can differ slightly too; they're far outside
  // the dense mouth cluster and fall out of the 15th–85th percentile box.
  const yEnd = Math.min(h, headTop + Math.round(h * 0.4));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = headTop; y < yEnd; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (a.px[i + 3]! < 200 || b.px[i + 3]! < 200) continue;
      const d = Math.abs(a.px[i]! - b.px[i]!) + Math.abs(a.px[i + 1]! - b.px[i + 1]!) + Math.abs(a.px[i + 2]! - b.px[i + 2]!);
      if (d > 120) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < 50) throw new Error(`no mouth difference found between ${closedPng} and ${openPng}`);
  // Anchor on the DENSEST band of differing rows: the mouth is a compact,
  // strong cluster; stray differences (necklace glints, a curl, the chin line)
  // are sparse and would drag a plain median/percentile box (measured: a 182 px
  // tall "mouth" on one pose before this).
  const rows = new Map<number, number>();
  for (const y of ys) rows.set(y, (rows.get(y) ?? 0) + 1);
  let bestY = ys[0]!;
  let best = -1;
  for (let y = headTop; y < yEnd; y++) {
    let sum = 0;
    for (let k = -12; k <= 12; k++) sum += rows.get(y + k) ?? 0;
    if (sum > best) { best = sum; bestY = y; }
  }
  const inBand = (y: number) => Math.abs(y - bestY) <= 45;
  const bx = xs.filter((_, i) => inBand(ys[i]!)).sort((p, q) => p - q);
  const by = ys.filter(inBand).sort((p, q) => p - q);
  const cx = percentile(bx, 0.5);
  const cy = percentile(by, 0.5);
  const mw = Math.max(40, percentile(bx, 0.9) - percentile(bx, 0.1));
  const mh = Math.min(Math.round(mw * 0.9), Math.max(24, percentile(by, 0.9) - percentile(by, 0.1)));
  return PoseMeta.parse({ width: w, height: h, headTop, mouth: { x: cx, y: cy, w: mw, h: mh } });
}

export const metaPath = (posesDir: string, pose: string) => join(posesDir, `${pose}.meta.json`);

/** Reads a pose's metadata, measuring and caching it on first use. */
export async function poseMeta(posesDir: string, pose: string): Promise<PoseMeta> {
  const p = metaPath(posesDir, pose);
  if (existsSync(p)) return PoseMeta.parse(JSON.parse(await readFile(p, "utf8")));
  const meta = await measurePose(join(posesDir, `${pose}.png`), join(posesDir, `${pose}-open.png`));
  await writeFile(p, JSON.stringify(meta, null, 2));
  return meta;
}
