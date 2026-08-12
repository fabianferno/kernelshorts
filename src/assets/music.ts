import { db, COLLECTIONS } from "../db/mongo.js";
import type { VaultAsset } from "../vault/index-vault.js";

export type MusicTrack = {
  id: string;
  name: string;
  path: string;
  durationS: number;
  mood: string[];
  licenseStatus: VaultAsset["licenseStatus"];
  loudnessLufs?: number;
  licenseSource?: string;
};

export type MusicSelection = {
  path: string;
  name: string;
  loudnessLufs?: number;
  license?: string;
  /** False when nothing matched `music_mood` and a licensed track was substituted.
   *  Never claim a match that didn't happen. */
  matchedMood: boolean;
  durationS: number;
};

/**
 * Selection rules (vault/README.md, PRD §4):
 *  - `licenseStatus: "missing"` is excluded unconditionally — hard rule.
 *  - Prefer a mood match that is long enough for the target duration.
 *  - Fall back to any licensed track, but report matchedMood: false.
 */
export function selectTrack(
  tracks: MusicTrack[],
  mood: string,
  targetDurationS: number,
): { track: MusicTrack; matchedMood: boolean } {
  const licensed = tracks.filter((t) => t.licenseStatus !== "missing");
  if (licensed.length === 0) {
    throw new Error(
      `No licensed music track available in the vault (checked ${tracks.length}; ` +
        `tracks with licenseStatus "missing" are excluded by rule).`,
    );
  }

  const wanted = mood.trim().toLowerCase();
  const moodMatched = licensed.filter((t) =>
    t.mood.some((m) => m.trim().toLowerCase() === wanted),
  );

  const longEnough = (list: MusicTrack[]) => list.filter((t) => t.durationS >= targetDurationS);
  // Longest first, so a fallback still gives the edit the most headroom.
  const byLength = (list: MusicTrack[]) => [...list].sort((a, b) => b.durationS - a.durationS);

  const pickFrom = (list: MusicTrack[]): MusicTrack | undefined => {
    const fits = longEnough(list);
    // Shortest track that still covers the video: least trimming, least loop risk.
    if (fits.length) return [...fits].sort((a, b) => a.durationS - b.durationS)[0];
    return byLength(list)[0];
  };

  const matched = pickFrom(moodMatched);
  if (matched) return { track: matched, matchedMood: true };
  return { track: pickFrom(licensed)!, matchedMood: false };
}

/** Reads the indexed vault catalog from MongoDB — the pipeline only ever sees
 *  indexed assets (vault/README.md). */
export async function loadMusicCatalog(): Promise<MusicTrack[]> {
  const docs = await (await db())
    .collection<VaultAsset>(COLLECTIONS.assets)
    .find({ category: "music", kind: "audio" })
    .toArray();
  return docs.map((d) => ({
    id: d.id,
    name: d.name,
    path: d.path,
    durationS: d.durationS ?? 0,
    mood: d.mood ?? [],
    licenseStatus: d.licenseStatus,
    loudnessLufs: d.loudnessLufs,
    licenseSource: d.licenseSource,
  }));
}

export async function selectMusic(
  mood: string,
  targetDurationS: number,
): Promise<MusicSelection> {
  const { track, matchedMood } = selectTrack(await loadMusicCatalog(), mood, targetDurationS);
  return {
    path: track.path,
    name: track.name,
    loudnessLufs: track.loudnessLufs,
    license: track.licenseSource ?? track.licenseStatus,
    matchedMood,
    durationS: track.durationS,
  };
}
