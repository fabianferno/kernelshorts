import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve, isAbsolute, extname, basename } from "node:path";
import { probeMedia } from "./ffprobe.js";
import type { AssetManifest } from "../shared/schemas.js";

const exec = promisify(execFile);

/**
 * Background music from the HeyGen catalog (10k+ tracks), via HyperFrames'
 * media-use `resolve --type bgm`, authenticated by the user's `heygen` CLI
 * OAuth session (the free-usage path). Replaces the vault music, which the
 * user asked not to use (2026-11-06).
 *
 * media-use is only in HyperFrames ≥ 0.8.x-late; the RENDER engine stays on
 * its own pin (package.json). This version is pinned too — a floating
 * `hyperframes@latest` would change what a resolve does on the day it runs.
 */
export const MEDIA_USE_VERSION = "0.8.185";

export class MusicUnavailable extends Error {}

function findAudioPath(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value == null) return undefined;
  if (typeof value === "string") return /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const p = findAudioPath(v, depth + 1);
      if (p) return p;
    }
    return undefined;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const k of ["path", "file", "localPath", "relPath", "output"]) {
      const p = findAudioPath(o[k], depth + 1);
      if (p) return p;
    }
    for (const v of Object.values(o)) {
      const p = findAudioPath(v, depth + 1);
      if (p) return p;
    }
  }
  return undefined;
}

/**
 * Resolves one catalog track for `intent` into `<projectDir>/.media/…` and
 * returns it as the manifest's music entry. If the track is shorter than
 * `neededS` it is looped (with a short crossfade at each seam) to cover it.
 */
export async function resolveCatalogMusic(
  intent: string,
  projectDir: string,
  neededS: number,
  log: (m: string) => void = () => {},
): Promise<NonNullable<AssetManifest["music"]>> {
  await mkdir(projectDir, { recursive: true });
  let stdout = "";
  try {
    ({ stdout } = await exec(
      "pnpm",
      ["dlx", "--allow-build=esbuild", `hyperframes@${MEDIA_USE_VERSION}`, "media-use", "resolve",
        "--type", "bgm", "--intent", intent, "--project", projectDir, "--json"],
      { maxBuffer: 1 << 24, timeout: 180_000 },
    ));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const detail = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || e.message;
    if (/auth|authenticat|login|credential/i.test(detail)) {
      throw new MusicUnavailable(
        `HeyGen music needs a signed-in heygen CLI: run \`heygen auth login --oauth\` ` +
          `(or set MUSIC_SOURCE=none in .env to render without music).\n${detail.slice(-400)}`,
      );
    }
    throw new MusicUnavailable(`music resolve failed for "${intent}": ${detail.slice(-600)}`);
  }
  const jsonLine = stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  const parsed = jsonLine ? (JSON.parse(jsonLine) as unknown) : undefined;
  let path = findAudioPath(parsed);
  if (!path) throw new MusicUnavailable(`music resolve returned no audio file: ${stdout.slice(-400)}`);
  if (!isAbsolute(path)) path = resolve(projectDir, path);
  if (!existsSync(path)) throw new MusicUnavailable(`music resolve named ${path}, which does not exist`);

  const probe = await probeMedia(path);
  const durationS = probe.durationS ?? 0;
  log(`  music: ${basename(path)} (${durationS.toFixed(1)}s) for "${intent}"`);

  let finalPath = path;
  if (durationS > 0 && durationS < neededS) {
    // Loop to length. acrossfade between copies hides the seam.
    const copies = Math.ceil(neededS / Math.max(1, durationS - 1.5)) + 1;
    finalPath = join(projectDir, `bed-looped${extname(path) === ".wav" ? ".wav" : ".m4a"}`);
    const inputs: string[] = [];
    for (let i = 0; i < copies; i++) inputs.push("-i", path);
    let chain = "[0:a]";
    const parts: string[] = [];
    for (let i = 1; i < copies; i++) {
      const out = i === copies - 1 ? "[out]" : `[x${i}]`;
      parts.push(`${chain}[${i}:a]acrossfade=d=1.5:c1=tri:c2=tri${out}`);
      chain = `[x${i}]`;
    }
    await exec("ffmpeg", [
      "-v", "error", "-y", ...inputs,
      "-filter_complex", parts.join(";"), "-map", "[out]", "-t", String(neededS + 1), finalPath,
    ]);
    log(`  music looped ×${copies} to ${(neededS + 1).toFixed(1)}s`);
  }

  return {
    path: finalPath,
    name: basename(path, extname(path)),
    license: `HeyGen catalog (media-use resolve, intent "${intent}")`,
  };
}
