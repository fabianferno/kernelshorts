import { z } from "zod";
import { converse, userTurn, parseJson } from "../llm/bedrock.js";
import type { ScriptJSON } from "../shared/schemas.js";
import type { ResearchBrief } from "../research/brief.js";

/**
 * Metadata agent (PRD §6): the title/description/hashtags a human pastes into
 * the upload form.
 *
 * Automated publishing is deferred, so this is the last machine-written thing
 * before a person takes over. That changes what "good" means here: the output
 * has to be copy-paste ready per platform, not a bag of fields a publisher
 * client would later assemble.
 */

// ─── Per-platform shape ─────────────────────────────────────────────────────
//
// Only ONE per-platform field earns its place: `instagram_caption`.
//
// YouTube and Instagram do not have the same fields at all. YouTube Shorts has
// a title (hard 100-char cap, shown as a headline) and a separate description
// where URLs are clickable. Instagram Reels has NO title field — there is one
// caption, links in it are inert plain text, and hashtags are conventionally
// part of the caption body rather than a separate input. So a YouTube-shaped
// {title, description, hashtags} triple cannot be pasted into Instagram: the
// title would be lost and the hashtags would have to be re-appended by hand.
//
// There is deliberately no `youtube_title` — it would be a duplicate of
// `title` under a longer name, and a second copy of a value is a second value
// to keep in sync. `title` IS the YouTube title, and its schema carries
// YouTube's cap because YouTube is the platform that enforces one.

const HASHTAG_CAP = 8;

/**
 * Hashtags YouTube and Instagram both treat as engagement bait. Rejected in
 * code as well as in the prompt: the prompt is a request, the schema is the
 * rule, and this is the field a model reaches for when it has nothing to say.
 */
const BANNED_HASHTAGS = new Set([
  "#viral", "#fyp", "#foryou", "#foryoupage", "#trending", "#explore",
  "#explorepage", "#like", "#follow", "#followme", "#subscribe", "#shorts",
  "#reels", "#instagram", "#youtube", "#video", "#viralvideo", "#tiktok",
]);

const Hashtag = z
  .string()
  .trim()
  .refine((h) => h.startsWith("#"), { message: 'must start with "#"' })
  .refine((h) => !/\s/.test(h), { message: "must not contain spaces" })
  .refine((h) => /^#[A-Za-z0-9_]{2,29}$/.test(h), {
    message: "must be # followed by 2-29 letters, digits or underscores",
  })
  .refine((h) => !BANNED_HASHTAGS.has(h.toLowerCase()), {
    message: "generic engagement-bait hashtag — use topic-specific tags",
  });

export const PublishMetadata = z.object({
  /**
   * HARD 100 chars — YouTube's `videos.insert` rejects anything longer, so a
   * title that fails here would fail at upload too. Enforced rather than
   * truncated: cutting at char 100 lands mid-word and the human pastes a
   * mangled sentence.
   */
  title: z.string().trim().min(10).max(100),
  /** Ends with the source attribution — see requireAttribution(). */
  description: z.string().trim().min(40).max(4800),
  hashtags: z.array(Hashtag).min(3).max(HASHTAG_CAP),
  /** Instagram's single field. Hashtags inline, attribution as plain text. */
  instagram_caption: z.string().trim().min(40).max(2200),
});
export type PublishMetadata = z.infer<typeof PublishMetadata>;

export interface MetadataInput {
  script: ScriptJSON;
  brief?: ResearchBrief;
}

export interface MetadataResult {
  metadata: PublishMetadata;
  inputTokens: number;
  outputTokens: number;
}

// ─── Attribution ────────────────────────────────────────────────────────────

/** HN item URL for a script's topic, when the script recorded an hn id. */
export function hnItemUrl(script: ScriptJSON): string | undefined {
  return script.topic.hn_id === undefined
    ? undefined
    : `https://news.ycombinator.com/item?id=${script.topic.hn_id}`;
}

/**
 * Case-insensitive, ignoring a trailing slash — the model reproduces a long
 * URL with the slash added or dropped roughly half the time, and a retry spent
 * on that is a retry not spent on the copy.
 */
export function containsUrl(text: string, url: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/\/+(?=$|[\s)\]])/g, "");
  return norm(text).includes(norm(url));
}

/**
 * The video is built from someone else's article and someone else's comment
 * thread. Both links belong in the description; this checks they survived the
 * model's rewrite instead of trusting the prompt.
 */
export function missingAttribution(text: string, urls: string[]): string[] {
  return urls.filter((u) => !containsUrl(text, u));
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const SYSTEM =
  "You write publish copy for a daily short-form video channel that covers " +
  "Hacker News stories for software developers. You output JSON only, with no " +
  "commentary.";

function buildPrompt(input: MetadataInput, urls: string[], feedback: string): string {
  const { script, brief } = input;
  const vo = script.beats.map((b) => `- ${b.vo_text}`).join("\n");

  return (
    `A ${script.target_duration_s}-second vertical video was made about this ` +
    `Hacker News story:\n\n` +
    `Title: ${script.topic.title}\n` +
    `Article: ${script.topic.url}\n` +
    (brief ? `\nWhat it is: ${brief.what_it_is}\nWhy it matters: ${brief.why_it_matters}\n` : "") +
    `\nThe full narration, in order:\n${vo}\n` +
    `Closing line: ${script.cta.vo_text}\n\n` +
    `Write the publish copy.\n\n` +
    `Rules:\n` +
    `- "title": a YouTube Shorts title, AT MOST 100 CHARACTERS including ` +
    `spaces. Concrete and specific to this story. No clickbait question marks ` +
    `stacked on ellipses, no ALL CAPS words, no emoji.\n` +
    `- "description": 2-4 short lines saying what the video shows, then a ` +
    `blank line, then EXACTLY these two lines, copied character for character:\n` +
    urls.map((u) => `    ${u}`).join("\n") +
    `\n- "hashtags": 3 to ${HASHTAG_CAP} tags, each starting with "#", no ` +
    `spaces inside a tag, letters/digits/underscores only, all different. ` +
    `They must name the actual technology or topic. Do NOT use generic ` +
    `engagement tags — #viral, #fyp, #foryou, #trending, #shorts, #reels and ` +
    `the like are rejected.\n` +
    `- "instagram_caption": Instagram has no title field and its links are not ` +
    `clickable, so this is ONE self-contained block: a hook line, a line or ` +
    `two of substance, the same two URLs as plain text, then the hashtags on ` +
    `the last line. Under 2200 characters.\n\n` +
    `Reply with a single JSON object in exactly this shape (this example is ` +
    `about a DIFFERENT story — do not copy its wording, its links or its tags):\n` +
    `{"title":"This Rust CLI reads your Postgres logs and finds the slow query",` +
    `"description":"A tiny CLI that parses Postgres logs and ranks queries by ` +
    `total time.\\nIt found a missing index in a 12GB log in under a second.\\n\\n` +
    `https://news.ycombinator.com/item?id=1234567\\nhttps://example.com/pg-tool",` +
    `"hashtags":["#postgres","#rust","#cli","#databases","#performance"],` +
    `"instagram_caption":"Your slowest query is hiding in your logs.\\n\\nA Rust ` +
    `CLI ranks Postgres queries by total time and found a missing index in a ` +
    `12GB log.\\n\\nhttps://news.ycombinator.com/item?id=1234567\\n` +
    `https://example.com/pg-tool\\n\\n#postgres #rust #cli #databases #performance"}` +
    (feedback ? `\n\nYour previous reply was rejected: ${feedback}` : "")
  );
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Per-field validation with errors the model can act on.
 *
 * Kept separate from the Bedrock call so the rules are unit-testable without
 * spending a token, and so a length failure reports the ACTUAL length — "title
 * is 118 characters, must be at most 100" gets a usable retry where "String
 * must contain at most 100 character(s)" gets another 118-char title.
 */
export function validateMetadata(
  raw: unknown,
  urls: string[],
): { ok: true; metadata: PublishMetadata } | { ok: false; errors: string[] } {
  const parsed = PublishMetadata.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => {
      const field = i.path.join(".");
      if (field === "title" && i.code === "too_big") {
        const len = typeof (raw as { title?: unknown })?.title === "string"
          ? (raw as { title: string }).title.trim().length
          : 0;
        return `title is ${len} characters — the limit is 100. Rewrite it shorter; do not cut it off mid-word.`;
      }
      return `${field}: ${i.message}`;
    });
    return { ok: false, errors };
  }

  const errors: string[] = [];
  const data = parsed.data;

  // Dedupe is case-insensitive: "#WebSockets" and "#websockets" are the same
  // tag to both platforms, and shipping both wastes one of only 8 slots.
  // NOTE: `!seen.add(x)` does NOT work — Set.add returns the Set, which is
  // always truthy, so that form silently accepts every duplicate.
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const h of data.hashtags) {
    const key = h.toLowerCase();
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  if (dupes.length > 0) errors.push(`duplicate hashtags: ${dupes.join(", ")}`);

  const missingDesc = missingAttribution(data.description, urls);
  if (missingDesc.length > 0) {
    errors.push(
      `description must end with the source links; missing: ${missingDesc.join(", ")}`,
    );
  }
  const missingIg = missingAttribution(data.instagram_caption, urls);
  if (missingIg.length > 0) {
    errors.push(
      `instagram_caption must include the source links as plain text; missing: ${missingIg.join(", ")}`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, metadata: data };
}

// ─── The call ───────────────────────────────────────────────────────────────

/**
 * One real Bedrock call, retried up to 3 times with the validation errors fed
 * back, then throws.
 *
 * Unlike ranking and directive translation there is no partial-success path to
 * salvage: metadata is a single object, so one bad field means the object is
 * not publishable and a retry is the only honest move.
 */
export async function generateMetadata(input: MetadataInput): Promise<MetadataResult> {
  const urls = [hnItemUrl(input.script), input.script.topic.url].filter(
    (u): u is string => !!u,
  );

  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await converse(userTurn(buildPrompt(input, urls, feedback), SYSTEM), {
      maxTokens: 1200,
      // Copywriting wants a little room; 0 produced the same flat "X is a tool
      // that does Y" title shape for every story.
      temperature: 0.4,
    });

    let raw: unknown;
    try {
      raw = parseJson<unknown>(res.text);
    } catch (err) {
      feedback = (err as Error).message.slice(0, 300);
      continue;
    }

    const result = validateMetadata(raw, urls);
    if (!result.ok) {
      feedback = result.errors.join(" | ").slice(0, 500);
      continue;
    }

    return {
      metadata: result.metadata,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    };
  }

  throw new Error(`Could not generate publish metadata after 3 attempts: ${feedback}`);
}
