/**
 * Hacker News as a SOURCE (not a topic picker): given a story you chose, get
 * its title/url and the discussion. Restored from the old research phase —
 * only the parts a human-picked reel needs.
 */

const ALGOLIA = "https://hn.algolia.com/api/v1";

export interface HnItem {
  id: number;
  title: string;
  url?: string;
  points: number;
  author: string;
  created_at: string;
}

/** Accepts an item id, a news.ycombinator.com/item?id=… URL, or returns undefined. */
export function parseHnId(input: string): number | undefined {
  if (/^\d+$/.test(input)) return Number(input);
  const m = input.match(/news\.ycombinator\.com\/item\?id=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

export async function fetchItem(hnId: number): Promise<HnItem & { children?: ItemNode[] }> {
  const res = await fetch(`${ALGOLIA}/items/${hnId}`);
  if (!res.ok) throw new Error(`Algolia HN items/${hnId} → ${res.status} ${res.statusText}`);
  const j = (await res.json()) as ItemNode & { title?: string; url?: string; created_at?: string };
  return {
    id: hnId,
    title: j.title ?? "",
    url: j.url ?? undefined,
    points: j.points ?? 0,
    author: j.author ?? "unknown",
    created_at: j.created_at ?? "",
    children: j.children,
  };
}

/** Today's front page, highest points first — for browsing, not auto-picking. */
export async function fetchFrontPage(): Promise<HnItem[]> {
  const res = await fetch(`${ALGOLIA}/search?tags=front_page&hitsPerPage=40`);
  if (!res.ok) throw new Error(`Algolia front_page → ${res.status}`);
  const j = (await res.json()) as {
    hits: Array<{ objectID: string; title: string; url?: string; points: number; author: string; created_at: string }>;
  };
  return j.hits
    .map((h) => ({ id: Number(h.objectID), title: h.title, url: h.url, points: h.points, author: h.author, created_at: h.created_at }))
    .sort((a, b) => b.points - a.points);
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

