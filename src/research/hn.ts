import { z } from "zod";
import { db, COLLECTIONS } from "../db/mongo.js";

/**
 * Phase 1 ingest (PRD §3.1–3.2): the live Algolia Hacker News API.
 *
 * No API key, no auth header — Algolia hosts HN search for free. Rate limit is
 * generous (10k req/hour per IP) and we make two calls per run, so there is no
 * backoff logic here on purpose.
 */

const ALGOLIA = "https://hn.algolia.com/api/v1";

export const HnStory = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  /** null for Ask HN / Show HN text posts — filterStories drops those. */
  url: z.string().nullable(),
  points: z.number().int(),
  num_comments: z.number().int(),
  author: z.string(),
  /** ISO8601, as Algolia returns it. */
  created_at: z.string(),
  hn_url: z.string(),
});
export type HnStory = z.infer<typeof HnStory>;

/**
 * Algolia's search hits. Fields are optional/nullable far more often than the
 * docs suggest: `points` and `num_comments` are null on very fresh items, and
 * `url` is null on every text post. Coerced to the strict HnStory below rather
 * than propagating nulls into the ranker.
 */
const AlgoliaHit = z.object({
  objectID: z.string(),
  title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  points: z.number().nullable().optional(),
  num_comments: z.number().nullable().optional(),
  author: z.string().nullable().optional(),
  created_at: z.string(),
});

const AlgoliaSearch = z.object({ hits: z.array(AlgoliaHit) });

function toStory(hit: z.infer<typeof AlgoliaHit>): HnStory | undefined {
  const id = Number(hit.objectID);
  if (!Number.isFinite(id) || !hit.title) return undefined;
  return HnStory.parse({
    id,
    title: hit.title,
    url: hit.url ?? null,
    points: hit.points ?? 0,
    num_comments: hit.num_comments ?? 0,
    author: hit.author ?? "unknown",
    created_at: hit.created_at,
    hn_url: `https://news.ycombinator.com/item?id=${id}`,
  });
}

/**
 * Front page as of now, restricted to items submitted in the last `windowHours`.
 *
 * Two calls, unioned, because neither endpoint alone is enough:
 * `tags=front_page` returns exactly what is on the front page right now (~30
 * items) but includes items submitted days ago; `search_by_date` with a
 * created_at_i floor covers the window but is ordered by recency, so a story
 * that peaked six hours ago sits behind dozens of one-point submissions. The
 * union gives current front page + everything recent that scored, and
 * filterStories applies the point threshold.
 */
export async function fetchFrontPage(windowHours = 24): Promise<HnStory[]> {
  const since = Math.floor(Date.now() / 1000) - windowHours * 3600;

  const urls = [
    `${ALGOLIA}/search?tags=front_page&hitsPerPage=50`,
    `${ALGOLIA}/search_by_date?tags=story&numericFilters=created_at_i>${since},points>50&hitsPerPage=100`,
  ];

  const byId = new Map<number, HnStory>();
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Algolia HN API ${res.status} ${res.statusText} for ${url}`);
    }
    const { hits } = AlgoliaSearch.parse(await res.json());
    for (const hit of hits) {
      const story = toStory(hit);
      if (!story) continue;
      if (Date.parse(story.created_at) < since * 1000) continue;
      // The front_page call can return a stale point count for an item that
      // also came back from search_by_date; keep whichever is higher.
      const seen = byId.get(story.id);
      if (!seen || story.points > seen.points) byId.set(story.id, story);
    }
  }

  return [...byId.values()].sort((a, b) => b.points - a.points);
}

// ─── Comments ───────────────────────────────────────────────────────────────

export interface HnComment {
  id: number;
  author: string;
  /** 1 = top-level reply to the story. */
  depth: number;
  text: string;
}

/** Top-level comments carry the arguments worth quoting in a script; replies
 *  are usually sub-thread bickering. Deeper than this is dropped. */
const MAX_COMMENT_DEPTH = 3;
const MAX_COMMENTS = 40;
const MAX_COMMENT_CHARS = 600;

interface ItemNode {
  id?: number;
  author?: string | null;
  text?: string | null;
  points?: number | null;
  children?: ItemNode[];
}

/**
 * Flattens Algolia's nested `children` tree into a ranked, truncated list.
 *
 * Ordering is by depth then original sibling order — NOT by points, despite
 * what the field list suggests: the items endpoint returns `points: null` for
 * every comment (HN stopped exposing per-comment scores publicly, verified
 * live 2026-08-13). Sibling order is HN's own ranking, so the first top-level
 * child is the top comment.
 */
export function flattenComments(root: ItemNode): HnComment[] {
  const out: HnComment[] = [];

  const walk = (node: ItemNode, depth: number): void => {
    for (const child of node.children ?? []) {
      if (depth <= MAX_COMMENT_DEPTH && child.id && child.text) {
        const text = stripHtml(child.text);
        if (text.length > 0) {
          out.push({
            id: child.id,
            author: child.author ?? "unknown",
            depth,
            text: text.length > MAX_COMMENT_CHARS
              ? `${text.slice(0, MAX_COMMENT_CHARS)}…`
              : text,
          });
        }
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 1);

  // Stable sort on depth only, so sibling order (HN's ranking) survives.
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.depth - b.c.depth || a.i - b.i)
    .slice(0, MAX_COMMENTS)
    .map((x) => x.c);
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&nbsp;": " ",
};

/** HN comment bodies are HTML fragments: <p>, <i>, <code>, <a href>, and
 *  entity-escaped text. Links are reduced to their text — the href is almost
 *  always the same string again. */
export function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    // Numeric entities are handled generically: HN escapes every URL slash as
    // &#x2F;, so a hand-written lookup table misses half of what shows up in a
    // real comment body (observed live: "https:&#x2F;&#x2F;api-docs...").
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchComments(hnId: number): Promise<HnComment[]> {
  const res = await fetch(`${ALGOLIA}/items/${hnId}`);
  if (!res.ok) {
    throw new Error(`Algolia HN items/${hnId} → ${res.status} ${res.statusText}`);
  }
  return flattenComments((await res.json()) as ItemNode);
}

// ─── Filter (PRD §3.2) ──────────────────────────────────────────────────────

/**
 * Minimum points to be considered.
 *
 * The front page bottoms out around 80–120 points on a normal weekday, so 100
 * is roughly "made the front page and stayed there". Lower thresholds pull in
 * items that briefly ranked on /newest and never got real discussion, which
 * means no comment material for the research brief (PRD §3.4).
 */
export const MIN_POINTS = 100;

/**
 * Domains behind a hard paywall. We cannot fetch the article for the research
 * brief and we cannot screen-record it for a beat (PRD §3.8), so the story is
 * unusable no matter how good it is. Soft/metered paywalls are deliberately
 * NOT listed — those usually serve the full text to a plain fetch.
 */
export const PAYWALLED_DOMAINS = [
  "wsj.com",
  "nytimes.com",
  "ft.com",
  "bloomberg.com",
  "economist.com",
  "theinformation.com",
  "newyorker.com",
  "wired.com",
  "hbr.org",
  "seekingalpha.com",
  "barrons.com",
  "thetimes.co.uk",
  "telegraph.co.uk",
  "washingtonpost.com",
  "nature.com",
  "science.org",
  "sciencedirect.com",
];

/**
 * Politics/culture-war keywords. These are matched on the TITLE only, and are
 * about risk (PRD §3.3 "licensing/controversy"), not about topic quality: a
 * daily automated channel cannot defend an opinion it did not intend to have.
 * Words that are ordinary in a tech headline ("bill", "court", "party") are
 * left out because the false-positive cost is a good story silently lost.
 */
export const POLITICAL_KEYWORDS = [
  "trump",
  "biden",
  "putin",
  "netanyahu",
  "election",
  "senate",
  "congress",
  "parliament",
  "republican",
  "democrat",
  "abortion",
  "immigration",
  "deportation",
  "gaza",
  "israel",
  "palestine",
  "ukraine war",
  "genocide",
  "shooting",
  "protest",
  "woke",
  "transgender",
  "vaccine mandate",
];

export interface DroppedStory {
  story: HnStory;
  reason: string;
}

/** Host without www, lowercased. Returns "" for an unparseable url. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Applies every §3.2 filter. Nothing is dropped silently — each rejection
 * carries the reason so the dashboard can show why today's obvious story is
 * not in the ranking.
 */
export function filterStories(stories: HnStory[]): {
  kept: HnStory[];
  dropped: DroppedStory[];
} {
  const kept: HnStory[] = [];
  const dropped: DroppedStory[] = [];

  for (const story of stories) {
    if (story.points < MIN_POINTS) {
      dropped.push({ story, reason: `below ${MIN_POINTS} points (${story.points})` });
      continue;
    }
    // Ask HN / Show HN with no link: nothing to screen-record, nothing to
    // read. Demonstrability is the whole format.
    if (!story.url) {
      dropped.push({ story, reason: "text post with no external url — not demonstrable" });
      continue;
    }
    const host = hostOf(story.url);
    if (!host) {
      dropped.push({ story, reason: `unparseable url: ${story.url}` });
      continue;
    }
    const paywall = PAYWALLED_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`));
    if (paywall) {
      dropped.push({ story, reason: `paywalled domain: ${paywall}` });
      continue;
    }
    const title = story.title.toLowerCase();
    const political = POLITICAL_KEYWORDS.find((k) => title.includes(k));
    if (political) {
      dropped.push({ story, reason: `political keyword in title: "${political}"` });
      continue;
    }
    kept.push(story);
  }

  return { kept, dropped };
}

// ─── Dedupe against published history (PRD §3.2) ────────────────────────────

/**
 * Canonical form for url comparison: no protocol, no www, no trailing slash,
 * no query or fragment. HN submissions of the same article routinely differ by
 * `?utm_source=`, http vs https, or a trailing slash, and an id-only check
 * misses all three (the same article gets resubmitted under a new HN id).
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export interface PublishedTopic {
  hn_id: number;
  url: string | null;
  /** normalizeUrl(url) — stored so the dedupe query can index on it. */
  normalized_url: string | null;
  title: string;
  run_id: string;
  published_at: Date;
}

/**
 * Drops stories we have already made a video about. Matches on hn id OR
 * normalized url, because the same article reappears under a new id.
 */
export async function dedupeAgainstPublished(stories: HnStory[]): Promise<{
  kept: HnStory[];
  dropped: DroppedStory[];
}> {
  if (stories.length === 0) return { kept: [], dropped: [] };

  const database = await db();
  const coll = database.collection<PublishedTopic>(COLLECTIONS.publishedTopics);

  const ids = stories.map((s) => s.id);
  const normalized = stories
    .map((s) => (s.url ? normalizeUrl(s.url) : null))
    .filter((u): u is string => u !== null);

  const published = await coll
    .find({ $or: [{ hn_id: { $in: ids } }, { normalized_url: { $in: normalized } }] })
    .toArray();

  const seenIds = new Set(published.map((p) => p.hn_id));
  const seenUrls = new Set(
    published.map((p) => p.normalized_url).filter((u): u is string => !!u),
  );

  const kept: HnStory[] = [];
  const dropped: DroppedStory[] = [];
  for (const story of stories) {
    if (seenIds.has(story.id)) {
      dropped.push({ story, reason: `already published (hn id ${story.id})` });
      continue;
    }
    if (story.url && seenUrls.has(normalizeUrl(story.url))) {
      dropped.push({ story, reason: `already published (same url: ${normalizeUrl(story.url)})` });
      continue;
    }
    kept.push(story);
  }
  return { kept, dropped };
}

/**
 * Records a topic as published. Called by M5 after a real successful upload —
 * not at pick time, so a run that dies before publishing leaves the topic
 * available for tomorrow. Upsert on hn_id makes a re-publish idempotent.
 */
export async function recordPublishedTopic(
  story: Pick<HnStory, "id" | "title" | "url">,
  runId: string,
): Promise<void> {
  const database = await db();
  await database.collection<PublishedTopic>(COLLECTIONS.publishedTopics).updateOne(
    { hn_id: story.id },
    {
      $set: {
        hn_id: story.id,
        url: story.url,
        normalized_url: story.url ? normalizeUrl(story.url) : null,
        title: story.title,
        run_id: runId,
        published_at: new Date(),
      },
    },
    { upsert: true },
  );
}
