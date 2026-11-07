import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

/**
 * Publishing settings. Deliberately NOT part of src/config.ts: the scheduler
 * runs every few minutes under launchd and must not need Bedrock, Mongo or
 * ElevenLabs keys just to say "nothing is due".
 */

const PIPELINE = resolve(process.env.PIPELINE_HOME ?? join(homedir(), "pipeline"));

export const PATHS = {
  posts: join(PIPELINE, "posts"),
  /** Rotating OAuth tokens (not static keys) — outside the repo, mode 0600. */
  auth: join(PIPELINE, "auth"),
  logs: join(PIPELINE, "logs"),
  brand: resolve(process.cwd(), "vault", "brand", "brand.json"),
};

const Posting = z.object({
  timezone: z.string().default("Asia/Kolkata"),
  /**
   * Starting slots, 2026-11-07: the account has no followers yet, so there is
   * no audience data. 7:30 pm IST is where the (vendor-blog, not platform)
   * guidance for Indian Instagram Reels and YouTube Shorts audiences overlaps.
   * Replace with the account's own numbers once Insights has some.
   */
  instagram: z.object({ time: z.string().default("19:30") }).default({ time: "19:30" }),
  youtube: z.object({ time: z.string().default("19:30") }).default({ time: "19:30" }),
  /** Past this, a missed Instagram slot (Mac asleep) moves to the next day. */
  maxLateHours: z.number().positive().default(3),
  /** A reel queued closer than this to today's slot goes tomorrow. */
  leadMinutes: z.number().nonnegative().default(20),
});
export type PostingSettings = z.infer<typeof Posting>;

/** Defaults, overridable per brand in vault/brand/brand.json → "posting". */
export function postingSettings(): PostingSettings {
  let raw: unknown = {};
  if (existsSync(PATHS.brand)) {
    raw = (JSON.parse(readFileSync(PATHS.brand, "utf8")) as { posting?: unknown }).posting ?? {};
  }
  return Posting.parse(raw);
}

export const env = {
  youtubeClientId: process.env.YOUTUBE_CLIENT_ID,
  youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET,
  /** Only used to seed ~/pipeline/auth/instagram.json; refreshed from there. */
  instagramAccessToken: process.env.INSTAGRAM_ACCESS_TOKEN,
};
