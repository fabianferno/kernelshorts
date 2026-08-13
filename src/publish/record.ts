import { db, COLLECTIONS } from "../db/mongo.js";
import {
  normalizeUrl,
  recordPublishedTopic,
  type PublishedTopic,
} from "../research/hn.js";
import { emit } from "../run/workspace.js";
import type { RunState } from "../shared/schemas.js";

/**
 * Recording a publish while publishing is still done BY HAND.
 *
 * The YouTube/Instagram API clients are deferred; for now a human uploads the
 * export themselves. Nothing about that is automatic, including the part the
 * pipeline depends on: `dedupeAgainstPublished` in src/research/hn.ts drops a
 * story only if it is in `published_topics`. If a video goes out and nothing
 * writes that row, tomorrow's run sees the topic as untouched and will happily
 * pick the exact same story again — and nobody finds out until a duplicate
 * video is already made. So every manual publish must end with a call here.
 * This is the only thing keeping the HN dedupe honest right now.
 */

export interface MarkPublishedInput {
  runId: string;
  /** HN item id. Absent only if the topic never came from HN. */
  hnId?: number;
  /** Article URL — the same one `dedupeAgainstPublished` matches on. */
  url: string;
  title: string;
  /** Where the human actually posted it. */
  platforms: string[];
  /** Free text: the live post URL, or why it went out edited. */
  notes?: string;
}

/**
 * A topic with no HN id still needs a stable `hn_id` key, because
 * recordPublishedTopic upserts on that field and PublishedTopic types it as a
 * number. A negative id derived from the normalized url can never collide with
 * a real HN id (those are positive) and keeps the upsert idempotent for repeat
 * publishes of the same url.
 */
export function syntheticHnId(url: string): number {
  const norm = normalizeUrl(url);
  let hash = 0;
  for (const ch of norm) hash = (hash * 31 + ch.codePointAt(0)!) % 2_000_000_000;
  return -(hash + 1);
}

export interface MarkPublishedResult {
  hnId: number;
  normalizedUrl: string;
}

/**
 * Writes the topic to `published_topics` and records the publish on the run
 * record and the dashboard event feed.
 *
 * The url normalization is NOT reimplemented here — recordPublishedTopic owns
 * it. Dedupe correctness depends on the write side and the read side producing
 * byte-identical normalized urls, and two copies of that logic drift.
 */
export async function markPublished(
  input: MarkPublishedInput,
): Promise<MarkPublishedResult> {
  const { runId, url, title, platforms, notes } = input;
  if (platforms.length === 0) {
    throw new Error("markPublished needs at least one platform — an unpublished video is not published");
  }

  const hnId = input.hnId ?? syntheticHnId(url);
  await recordPublishedTopic({ id: hnId, title, url }, runId);

  const publishedAt = new Date().toISOString();
  // Written straight onto the run record so the dashboard's run view shows the
  // publish without replaying the whole event feed.
  const runUpdate = await (await db()).collection<RunState>(COLLECTIONS.runs).updateOne(
    { run_id: runId },
    { $set: { published: { platforms, url, title, hn_id: hnId, notes, published_at: publishedAt } } },
  );

  // Deliberately NOT an upsert: a half-built run document with only a
  // `published` field would fail RunState.parse the next time anything loads
  // it. A missing run record is a real mismatch worth seeing in the feed, and
  // it must not swallow the publish — the published_topics row above is the
  // load-bearing write and it already succeeded.
  if (runUpdate.matchedCount === 0) {
    await emit(runId, "publish", "error", `no run record for ${runId}; topic recorded but the run document was not updated`);
  }

  await emit(runId, "publish", "artifact", `published manually to ${platforms.join(", ")}: ${title}`, {
    url,
    hn_id: hnId,
    platforms,
    notes,
    published_at: publishedAt,
  });

  return { hnId, normalizedUrl: normalizeUrl(url) };
}

/**
 * Pre-flight check before making a video (or before a manual upload): has this
 * article already gone out? Matches on the normalized url only — the caller
 * may not have an HN id, and the url is what survives a resubmission.
 */
export async function isAlreadyPublished(url: string): Promise<boolean> {
  const database = await db();
  const found = await database
    .collection<PublishedTopic>(COLLECTIONS.publishedTopics)
    .findOne({ normalized_url: normalizeUrl(url) });
  return found !== null;
}
