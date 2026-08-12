import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { config } from "../config.js";

const exec = promisify(execFile);

/**
 * Generates the gradient scrim: opaque black at the top fading to fully
 * transparent by mid-frame.
 *
 * Box treatments carry their own background, but the hard-shadow titles sit
 * directly on the footage, where a bright frame (a white documentation page, a
 * daylit stock clip) leaves white text with only a 4px shadow to hold it. The
 * scrim darkens the top half of the frame just enough for the title to read,
 * without dimming the part of the image the viewer is actually watching.
 *
 * Rendered once per run with ffmpeg's geq filter — alpha ramps 255 → 0 linearly
 * over the top half — because Palmier's import_media `matte` source produces
 * only flat colour, with no gradient option.
 */
export async function ensureScrim(outPath: string): Promise<string> {
  if (existsSync(outPath)) return outPath;

  const { width, height } = config.video;
  await exec("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}`,
    "-vf", "format=rgba,geq=r=0:g=0:b=0:a='255*max(0,1-Y/(H/2))'",
    "-frames:v", "1",
    outPath,
  ]);
  return outPath;
}
