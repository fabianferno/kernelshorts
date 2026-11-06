import { readdir, stat, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, extname, basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { config } from "../config.js";
import { db, COLLECTIONS } from "../db/mongo.js";
import { converse, userTurn, parseJson } from "../llm/bedrock.js";

const exec = promisify(execFile);

const MEDIA_EXT = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".aiff",
  ".mp4", ".mov", ".m4v", ".webm",
  ".png", ".jpg", ".jpeg", ".heic", ".webp",
  ".ttf", ".otf",
]);

/** Folders where a licence is mandatory (see vault/README.md). */
const LICENSE_REQUIRED = new Set(["music", "sfx", "stock", "overlays", "images"]);

export const VaultAsset = z.object({
  id: z.string(),
  category: z.enum(["music", "sfx", "brand", "fonts", "stock", "voice", "host", "overlays", "images"]),
  /** Overlays only: true when the file carries an alpha channel (keyed green screen). */
  alpha: z.boolean().optional(),
  path: z.string(),
  relPath: z.string(),
  name: z.string(),
  ext: z.string(),
  bytes: z.number(),
  kind: z.enum(["audio", "video", "image", "font"]),
  durationS: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  sampleRate: z.number().optional(),
  loudnessLufs: z.number().optional(),
  licenseStatus: z.enum(["ok", "missing", "exempt"]),
  licenseSource: z.string().optional(),
  mood: z.array(z.string()).default([]),
  bpm: z.number().optional(),
  indexedAt: z.string(),
});
export type VaultAsset = z.infer<typeof VaultAsset>;

function kindOf(ext: string): VaultAsset["kind"] {
  if ([".ttf", ".otf", ".woff2"].includes(ext)) return "font";
  if ([".png", ".jpg", ".jpeg", ".heic", ".webp"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".m4v", ".webm"].includes(ext)) return "video";
  return "audio";
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/** Real ffprobe on the real file. No inference from filename. */
async function probe(path: string): Promise<Partial<VaultAsset>> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", path,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string; width?: number; height?: number;
      r_frame_rate?: string; sample_rate?: string;
    }>;
  };
  const v = data.streams?.find((s) => s.codec_type === "video");
  const a = data.streams?.find((s) => s.codec_type === "audio");
  const [num, den] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationS: data.format?.duration ? Number(data.format.duration) : undefined,
    width: v?.width,
    height: v?.height,
    fps: num && den ? Math.round((num / den) * 1000) / 1000 : undefined,
    sampleRate: a?.sample_rate ? Number(a.sample_rate) : undefined,
  };
}

/** Real loudnorm scan — lets the music bed be ducked to a known level rather
 *  than a guessed dB offset (PRD §4). */
async function measureLoudness(path: string): Promise<number | undefined> {
  try {
    const { stderr } = await exec("ffmpeg", [
      "-hide_banner", "-nostats", "-i", path,
      "-af", "loudnorm=I=-14:print_format=summary", "-f", "null", "-",
    ], { maxBuffer: 1024 * 1024 * 8 });
    const m = stderr.match(/Input Integrated:\s*(-?[\d.]+)\s*LUFS/);
    return m?.[1] ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pairs a media file with its licence. Two accepted forms (vault/README.md):
 * a sidecar .txt sharing the filename stem, or a LICENSE.md governing the folder.
 */
async function findLicense(path: string, siblings: string[]): Promise<{
  status: VaultAsset["licenseStatus"];
  source?: string;
}> {
  const category = relative(config.paths.vault, path).split("/")[0] ?? "";
  if (!LICENSE_REQUIRED.has(category)) return { status: "exempt" };

  const stem = basename(path, extname(path));
  // NCS/Pixabay downloads name licences like
  // "beats-gorila-315977-license.txt" for "gorila-315977.mp3" — the media stem
  // appears inside the licence filename, not necessarily at its start.
  const sidecar = siblings.find(
    (s) =>
      s !== path &&
      [".txt", ".md", ".pdf"].includes(extname(s).toLowerCase()) &&
      basename(s).toLowerCase().includes(stem.toLowerCase()),
  );
  if (sidecar) return { status: "ok", source: relative(config.paths.vault, sidecar) };

  const folderLicense = join(dirname(path), "LICENSE.md");
  if (existsSync(folderLicense)) {
    return { status: "ok", source: relative(config.paths.vault, folderLicense) };
  }
  return { status: "missing" };
}

/** User-authored overrides always win and survive re-indexing. */
const TagOverrides = z.record(
  z.string(),
  z.object({ mood: z.array(z.string()).optional(), bpm: z.number().optional() }),
);

async function loadOverrides(): Promise<z.infer<typeof TagOverrides>> {
  const p = join(config.paths.vault, "music", "tags.json");
  if (!existsSync(p)) return {};
  return TagOverrides.parse(JSON.parse(await readFile(p, "utf8")));
}

/** Real Bedrock call. Titles are descriptive ("night-detective", "future-bass
 *  stylish deep electronic"), so this proposes usable moods the user can correct. */
async function proposeMoods(names: string[]): Promise<Record<string, string[]>> {
  if (names.length === 0) return {};
  const res = await converse(
    userTurn(
      `Track filenames:\n${names.map((n) => `- ${n}`).join("\n")}\n\n` +
        `Return JSON: {"<filename>": ["mood", "mood"]} using 2-3 moods each from ` +
        `this vocabulary only: upbeat-tech, energetic, tense, cinematic, chill, ` +
        `lofi, ambient, dramatic, playful, corporate, dark, uplifting.`,
      `You tag background music for short-form tech videos. Infer mood from the ` +
        `filename, which usually names the genre and feel. Output JSON only.`,
    ),
    { maxTokens: 900, temperature: 0 },
  );
  try {
    return parseJson<Record<string, string[]>>(res.text);
  } catch {
    // Tagging is advisory; the user's tags.json is authoritative. Failing to
    // parse leaves moods empty rather than inventing them.
    return {};
  }
}

export async function indexVault(): Promise<VaultAsset[]> {
  const files = await walk(config.paths.vault);
  const media = files.filter((f) => MEDIA_EXT.has(extname(f).toLowerCase()));
  const overrides = await loadOverrides();

  const assets: VaultAsset[] = [];
  for (const path of media) {
    const relPath = relative(config.paths.vault, path);
    const category = relPath.split("/")[0] as VaultAsset["category"];
    const ext = extname(path).toLowerCase();
    const kind = kindOf(ext);
    const siblings = files.filter((f) => dirname(f) === dirname(path));

    const info = kind === "font" ? {} : await probe(path);
    const license = await findLicense(path, siblings);
    const loudness =
      kind === "audio" && category === "music" ? await measureLoudness(path) : undefined;

    assets.push(
      VaultAsset.parse({
        id: relPath,
        category,
        path,
        relPath,
        name: basename(path, ext),
        ext,
        bytes: (await stat(path)).size,
        kind,
        ...info,
        loudnessLufs: loudness,
        licenseStatus: license.status,
        licenseSource: license.source,
        mood: [],
        indexedAt: new Date().toISOString(),
      }),
    );
  }

  // Mood-tag music: propose with Gemma, then let overrides win.
  const music = assets.filter((a) => a.category === "music" && a.kind === "audio");
  const proposed = await proposeMoods(music.map((a) => basename(a.path)));
  for (const a of music) {
    const file = basename(a.path);
    a.mood = overrides[file]?.mood ?? proposed[file] ?? [];
    a.bpm = overrides[file]?.bpm;
  }

  await writeFile(config.paths.vaultIndex, JSON.stringify(assets, null, 2));

  const collection = (await db()).collection<VaultAsset>(COLLECTIONS.assets);
  await collection.createIndex({ id: 1 }, { unique: true });
  for (const a of assets) {
    await collection.replaceOne({ id: a.id }, a, { upsert: true });
  }
  // Assets deleted from disk must not linger in the catalog.
  await collection.deleteMany({ id: { $nin: assets.map((a) => a.id) } });

  return assets;
}
