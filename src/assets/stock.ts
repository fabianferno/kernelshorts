import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { db, COLLECTIONS } from "../db/mongo.js";
import { AcquiredAsset, type StockSpec as StockSpecType } from "../shared/schemas.js";
import { probeMedia } from "./ffprobe.js";
import type { VaultAsset } from "../vault/index-vault.js";

export type StockSpec = z.infer<typeof StockSpecType>;

export type StockProvider = "pexels" | "pixabay";

export type StockCandidate = {
  provider: StockProvider;
  id: string;
  downloadUrl: string;
  width: number;
  height: number;
  durationS: number;
  /** Human-facing page, used as the licence URL. */
  pageUrl: string;
  /** Pexels requires photographer attribution; Pixabay credits the uploader. */
  attribution: string;
};

const execFileAsync = promisify(execFile);

const MIN_HEIGHT = 1080;

/**
 * Portrait + ≥1080p is a hard filter (PRD §4). Among survivors, a clip that
 * covers the beat always beats one that would need looping/freezing; then more
 * pixels; then the tightest duration fit so we aren't trimming 60s for a 5s beat.
 */
export function pickBest(candidates: StockCandidate[], neededS: number): StockCandidate {
  const portrait = candidates.filter((c) => c.height > c.width && c.height >= MIN_HEIGHT);
  if (portrait.length === 0) {
    throw new Error(
      `No portrait ≥${MIN_HEIGHT}p stock clip among ${candidates.length} candidate(s)`,
    );
  }
  const ranked = [...portrait].sort((a, b) => {
    const aLong = a.durationS >= neededS ? 1 : 0;
    const bLong = b.durationS >= neededS ? 1 : 0;
    if (aLong !== bLong) return bLong - aLong;
    const aPx = a.width * a.height;
    const bPx = b.width * b.height;
    if (aPx !== bPx) return bPx - aPx;
    return Math.abs(a.durationS - neededS) - Math.abs(b.durationS - neededS);
  });
  return ranked[0]!;
}

// ─── Pexels ─────────────────────────────────────────────────────────────────

const PexelsResponse = z.object({
  videos: z
    .array(
      z.object({
        id: z.number(),
        url: z.string(),
        duration: z.number(),
        user: z.object({ name: z.string(), url: z.string().optional() }),
        video_files: z.array(
          z.object({
            link: z.string(),
            width: z.number().nullable(),
            height: z.number().nullable(),
            file_type: z.string().optional(),
          }),
        ),
      }),
    )
    .default([]),
});

export async function searchPexels(query: string): Promise<StockCandidate[]> {
  const url =
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}` +
    `&orientation=portrait&size=medium&per_page=20`;
  const res = await fetch(url, { headers: { Authorization: config.stock.pexelsKey } });
  if (!res.ok) {
    throw new Error(`Pexels search failed: ${res.status} ${await res.text()}`);
  }
  const body = PexelsResponse.parse(await res.json());
  const out: StockCandidate[] = [];
  for (const v of body.videos) {
    // Each result carries several renditions; take the largest portrait mp4.
    const files = v.video_files
      .filter((f) => (f.file_type ?? "video/mp4") === "video/mp4" && f.width && f.height)
      .sort((a, b) => (b.width! * b.height!) - (a.width! * a.height!));
    const best = files[0];
    if (!best) continue;
    out.push({
      provider: "pexels",
      id: String(v.id),
      downloadUrl: best.link,
      width: best.width!,
      height: best.height!,
      durationS: v.duration,
      pageUrl: v.url,
      attribution: `Video by ${v.user.name} on Pexels (${v.url})`,
    });
  }
  return out;
}

// ─── Pixabay ────────────────────────────────────────────────────────────────

const PixabayVideoFile = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
});

const PixabayResponse = z.object({
  hits: z
    .array(
      z.object({
        id: z.number(),
        pageURL: z.string(),
        duration: z.number(),
        user: z.string(),
        videos: z.record(z.string(), PixabayVideoFile),
      }),
    )
    .default([]),
});

export async function searchPixabay(query: string): Promise<StockCandidate[]> {
  const url =
    `https://pixabay.com/api/videos/?key=${config.stock.pixabayKey}` +
    `&q=${encodeURIComponent(query)}&per_page=20&safesearch=true`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Pixabay search failed: ${res.status} ${await res.text()}`);
  }
  const body = PixabayResponse.parse(await res.json());
  const out: StockCandidate[] = [];
  for (const hit of body.hits) {
    const files = Object.values(hit.videos)
      .filter((f) => f.width > 0 && f.height > 0)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    // Pixabay serves one orientation per hit; keep the largest portrait rendition.
    const best = files.find((f) => f.height > f.width) ?? files[0];
    if (!best) continue;
    out.push({
      provider: "pixabay",
      id: String(hit.id),
      downloadUrl: best.url,
      width: best.width,
      height: best.height,
      durationS: hit.duration,
      pageUrl: hit.pageURL,
      attribution: `Video by ${hit.user} on Pixabay (${hit.pageURL})`,
    });
  }
  return out;
}

const LICENSE_URL: Record<StockProvider, string> = {
  pexels: "https://www.pexels.com/license/",
  pixabay: "https://pixabay.com/service/license-summary/",
};

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Stock download failed: ${res.status} ${url}`);
  }
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * M0 documented that a source at a different fps is placed on the 30fps timeline
 * without conforming, so anything acquired at another rate is re-encoded here
 * rather than left to drift in the edit. Returns the path to use (unchanged when
 * the clip is already at the project fps).
 */
export async function conformToProjectFps(path: string): Promise<string> {
  const info = await probeMedia(path);
  if (info.fps === config.video.fps) return path;
  const out = path.replace(/\.mp4$/i, "") + `-${config.video.fps}fps.mp4`;
  await execFileAsync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", path,
      "-r", String(config.video.fps),
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-c:a", "copy",
      out,
    ],
    { maxBuffer: 1024 * 1024 * 16 },
  );
  return out;
}

// ─── Vault-first lookup (StockSpec.preferVault) ─────────────────────────────

/** The vault holds hand-picked clips we'd rather reuse than re-fetch (vault/README).
 *  Only indexed, licensed, portrait clips are eligible. */
export async function findVaultStock(
  query: string,
  neededS: number,
): Promise<VaultAsset | undefined> {
  const terms = query.split(/\s+/).filter((t) => t.length > 2);
  const collection = (await db()).collection<VaultAsset>(COLLECTIONS.assets);
  const docs = await collection
    .find({
      category: "stock",
      kind: "video",
      licenseStatus: { $ne: "missing" },
      ...(terms.length
        ? { $or: terms.map((t) => ({ id: { $regex: t, $options: "i" } })) }
        : {}),
    })
    .toArray();
  const usable = docs.filter(
    (d) => (d.height ?? 0) > (d.width ?? 0) && (d.height ?? 0) >= MIN_HEIGHT,
  );
  if (usable.length === 0) return undefined;
  usable.sort((a, b) => {
    const aLong = (a.durationS ?? 0) >= neededS ? 1 : 0;
    const bLong = (b.durationS ?? 0) >= neededS ? 1 : 0;
    if (aLong !== bLong) return bLong - aLong;
    return (b.height ?? 0) - (a.height ?? 0);
  });
  return usable[0];
}

export type AcquireStockOptions = {
  workspace: string;
  beatId: string;
  /** Seconds of footage this beat needs. */
  neededS: number;
};

/**
 * Queries BOTH providers, picks the best fit, downloads it into the run
 * workspace and ffprobes the real file. Licence metadata is recorded truthfully
 * per provider — Pexels requires photographer attribution.
 */
export async function acquireStock(
  spec: StockSpec,
  opts: AcquireStockOptions,
): Promise<AcquiredAsset> {
  const outDir = join(opts.workspace, "assets");
  await mkdir(outDir, { recursive: true });

  if (spec.preferVault) {
    const vaultHit = await findVaultStock(spec.query, opts.neededS);
    if (vaultHit) {
      const info = await probeMedia(vaultHit.path);
      return AcquiredAsset.parse({
        beat_id: opts.beatId,
        kind: "vault",
        path: vaultHit.path,
        durationS: info.durationS,
        width: info.width,
        height: info.height,
        fps: info.fps,
        license: {
          provider: "vault",
          url: vaultHit.licenseSource,
          attribution: `Vault asset ${vaultHit.relPath} (licence: ${
            vaultHit.licenseSource ?? vaultHit.licenseStatus
          })`,
        },
      });
    }
  }

  const [pexels, pixabay] = await Promise.all([
    searchPexels(spec.query),
    searchPixabay(spec.query),
  ]);
  const all = [...pexels, ...pixabay];
  if (all.length === 0) {
    throw new Error(
      `Beat "${opts.beatId}": neither Pexels nor Pixabay returned any clip for "${spec.query}"`,
    );
  }
  let chosen: StockCandidate;
  try {
    chosen = pickBest(all, opts.neededS);
  } catch (e) {
    throw new Error(`Beat "${opts.beatId}": ${(e as Error).message} for "${spec.query}"`);
  }

  const raw = join(outDir, `${opts.beatId}-${chosen.provider}-${chosen.id}.mp4`);
  await download(chosen.downloadUrl, raw);
  const dest = await conformToProjectFps(raw);
  const info = await probeMedia(dest);
  if (!info.width || !info.height) {
    throw new Error(`Beat "${opts.beatId}": downloaded stock file ${dest} has no video stream`);
  }

  return AcquiredAsset.parse({
    beat_id: opts.beatId,
    kind: "stock",
    path: dest,
    durationS: info.durationS,
    width: info.width,
    height: info.height,
    fps: info.fps,
    sourceUrl: chosen.pageUrl,
    license: {
      provider: chosen.provider,
      url: LICENSE_URL[chosen.provider],
      attribution: chosen.attribution,
    },
  });
}
