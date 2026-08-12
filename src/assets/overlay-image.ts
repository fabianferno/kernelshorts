import { writeFile, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, extname } from "node:path";
import { OverlayImage, type Beat } from "../shared/schemas.js";
import { probeMedia } from "./ffprobe.js";

const exec = promisify(execFile);

/** Width to rasterize vector sources at — comfortably above overlay size at
 *  1080p so the result stays sharp when scaled down. */
const RASTER_WIDTH = 1024;

/** Sniffs SVG by content, since a URL may carry no useful extension. */
async function isSvgContent(path: string): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const head = (await readFile(path)).subarray(0, 512).toString("utf8").trimStart();
  return head.startsWith("<svg") || head.startsWith("<?xml");
}

/**
 * Fetches a beat's on-screen image overlay and normalizes it to PNG.
 *
 * Palmier accepts png/jpg/jpeg/tiff/heic only, so anything else (a GIF logo, a
 * WebP asset) is transcoded here rather than failing at import. PNG is the
 * target because these overlays are logos and screenshot crops, where
 * transparency and sharp edges matter.
 */
export async function acquireOverlayImage(
  beat: Beat,
  workspace: string,
): Promise<OverlayImage | undefined> {
  const spec = beat.on_screen_image;
  if (!spec) return undefined;

  const outDir = join(workspace, "assets");
  const raw = join(outDir, `${beat.id}-overlay-src${extname(spec.source) || ".bin"}`);
  const png = join(outDir, `${beat.id}-overlay.png`);

  if (spec.source.startsWith("http://") || spec.source.startsWith("https://")) {
    const res = await fetch(spec.source);
    if (!res.ok) {
      throw new Error(
        `Overlay image for beat "${beat.id}" failed: ${res.status} ${res.statusText} ` +
          `for ${spec.source}`,
      );
    }
    await writeFile(raw, Buffer.from(await res.arrayBuffer()));
  } else {
    await copyFile(spec.source, raw);
  }

  // SVG needs a different renderer: ffmpeg has no SVG decoder at all (verified
  // against the local build's decoder list), and logos are very often SVG —
  // Hacker News serves its Y as y18.svg. rsvg-convert rasterizes at a chosen
  // width, so a 18px-declared logo still renders crisply at overlay size.
  const isSvg =
    spec.source.toLowerCase().endsWith(".svg") ||
    (await isSvgContent(raw));

  if (isSvg) {
    try {
      await exec("rsvg-convert", ["-w", String(RASTER_WIDTH), "-o", png, raw]);
    } catch (err) {
      throw new Error(
        `Overlay image for beat "${beat.id}" is an SVG and rsvg-convert is not ` +
          `available (ffmpeg cannot decode SVG). Install it with ` +
          `\`brew install librsvg\`, or point on_screen_image.source at a ` +
          `PNG/JPEG instead. Underlying error: ${(err as Error).message}`,
      );
    }
  } else {
    // ffmpeg normalizes format and takes a GIF's first frame, failing loudly on
    // anything undecodable.
    await exec("ffmpeg", ["-v", "error", "-y", "-i", raw, "-frames:v", "1", png]);
  }

  const probe = await probeMedia(png);
  if (!probe.width || !probe.height) {
    throw new Error(`Overlay image for beat "${beat.id}" produced no usable PNG`);
  }

  return OverlayImage.parse({
    beat_id: beat.id,
    path: png,
    width: probe.width,
    height: probe.height,
    scale: spec.scale,
    centerY: spec.centerY,
  });
}
