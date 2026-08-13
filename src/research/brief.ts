import { z } from "zod";
import { converse, userTurn, parseJson } from "../llm/bedrock.js";
import type { SourceDoc } from "./fetch-source.js";

/**
 * Research brief (PRD §3.4): article + product site + docs + HN comments →
 * a brief with a claim→source table.
 *
 * Two stages on purpose, not one:
 *
 *   1. EXTRACT, once per source chunk. The model sees ONE source at a time and
 *      is asked only to copy quotable facts out of it. Verbatim copying degrades
 *      fast as the prompt gets longer and as the model is asked to do a second
 *      job at the same time, so this stage does nothing else — and because the
 *      call knows which source it was given, `source_url` cannot be mis-attributed
 *      by the model at all.
 *   2. SYNTHESISE. The narrative fields plus the skeptic take are written from
 *      the story, the HN comments, and stage 1's already-verified excerpts.
 *
 * Excerpt fidelity is only *made possible* here — verification is the separate
 * fact-check verifier's job (PRD §3.5). What this module owes it: every claim
 * carries a source_url that was actually fetched, and an excerpt the model was
 * told to copy character-for-character out of text it was actually shown.
 */

// ─── Budgets (documented, per the fact-checker's needs) ─────────────────────

/**
 * Characters of one source shown per extraction call. ~6k chars ≈ 1.5k tokens;
 * kept small because verbatim copy accuracy is the whole point and it falls off
 * with prompt length on Gemma.
 */
const CHUNK_CHARS = 6000;

/**
 * Chunks taken per source, from the top. 2 × 6k = 12k chars per source — enough
 * to cover the lede and body of a typical HN-linked blog post, which is where
 * the quotable numbers live. Text past this is NOT shown to the model, so no
 * excerpt can come from it (the fact-checker still searches the full text, so a
 * surviving excerpt is never rejected for being outside the budget).
 */
const MAX_CHUNKS_PER_SOURCE = 2;

/** HN comment text shown to the synthesis call. The critical replies are the
 *  most valuable part of HN, so this is generous relative to the article. */
const COMMENTS_CHARS = 9000;

/** Candidate claims carried from stage 1 into stage 2. */
const MAX_CANDIDATE_CLAIMS = 24;

// ─── Schema ─────────────────────────────────────────────────────────────────

export const BriefClaim = z.object({
  text: z.string().min(1),
  source_url: z.string().url(),
  /** VERBATIM text from that source. The fact-checker substring-matches this. */
  excerpt: z.string().min(1),
});
export type BriefClaim = z.infer<typeof BriefClaim>;

export const ResearchBrief = z.object({
  topic: z.string().min(1),
  summary: z.string().min(1),
  what_it_is: z.string().min(1),
  why_it_matters: z.string().min(1),
  how_it_works: z.string().min(1),
  notable_numbers: z.array(z.string()).default([]),
  /** Drawn from the critical HN replies, not invented balance. */
  skeptic_take: z.string().min(1),
  /** What we would screen-record for the video (PRD §4 asset acquisition). */
  demo_surface: z.object({
    url: z.string().url(),
    what_to_show: z.string().min(1),
  }),
  claims: z.array(BriefClaim).min(1),
});
export type ResearchBrief = z.infer<typeof ResearchBrief>;

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface BriefStory {
  hn_id?: number;
  title: string;
  url: string;
  points?: number;
}

export interface BriefComment {
  author?: string;
  text: string;
  points?: number;
}

export interface BuildBriefInput {
  story: BriefStory;
  comments: BriefComment[];
  /** Real fetched sources from fetchSources(). At least one is required. */
  sources: SourceDoc[];
}

export interface BuildBriefResult {
  brief: ResearchBrief;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Total Converse calls made (extraction chunks + synthesis attempts). */
  calls: number;
  /** Claims stage 1 produced before synthesis chose among them. */
  candidateClaims: number;
}

// ─── Stage 1: per-source extraction ─────────────────────────────────────────

const EXTRACT_SYSTEM =
  "You are a research assistant preparing a claim->source table. You never paraphrase inside an excerpt. An excerpt that is not a character-for-character copy of the source text is worthless and will be discarded.";

function chunk(text: string, size: number, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < max; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

function extractPrompt(source: SourceDoc, body: string, part: number, parts: number): string {
  return `# SOURCE
url: ${source.url}
title: ${source.title}
(part ${part} of ${parts} of this page's text)

--- BEGIN SOURCE TEXT ---
${body}
--- END SOURCE TEXT ---

# TASK
Pull out up to 6 factual, checkable statements this text supports. Prefer statements with numbers, versions, dates, names, or concrete capabilities. Skip navigation text, marketing slogans, and anything you cannot point at a sentence for.

For each one give:
- "text": the fact in your own words, one sentence.
- "excerpt": a span of AT LEAST 8 WORDS COPIED CHARACTER-FOR-CHARACTER from the SOURCE TEXT above that supports it.

RULES FOR "excerpt" (these are the whole point of this task):
1. Copy it. Do not reword, shorten, fix, translate, or clean up punctuation. Do not add "..." .
2. It must be findable with an exact string search of the SOURCE TEXT above. If you cannot copy an exact span, drop that fact entirely.
3. Keep the original capitalisation, hyphens, and quote characters exactly as they appear.
4. Never quote from anywhere other than the SOURCE TEXT above.

Return ONLY a JSON array, no prose and no markdown fence. Example of the shape (the content is from an unrelated page — never copy it):
[
  {"text": "The library parses a million rows per second.", "excerpt": "benchmarks show it parsing 1,000,000 rows per second on a laptop"},
  {"text": "It has been maintained since 2014.", "excerpt": "first released in 2014 and maintained continuously since"}
]
If nothing in this text is quotable, return [].`;
}

interface RawExtract {
  text?: unknown;
  excerpt?: unknown;
}

// ─── Stage 2: synthesis ─────────────────────────────────────────────────────

const SYNTH_SYSTEM =
  "You are writing a research brief that a short-form video script will be built from. You are grounded: every claim you make must be one of the supplied source-backed claims, copied unchanged.";

function synthPrompt(args: {
  story: BriefStory;
  comments: BriefComment[];
  sources: SourceDoc[];
  candidates: BriefClaim[];
}): string {
  const { story, comments, sources, candidates } = args;

  const commentBlock = renderComments(comments, COMMENTS_CHARS);
  const sourceList = sources.map((s) => `- ${s.url} — ${s.title}`).join("\n");
  const claimBlock = candidates
    .map((c, i) => `${i + 1}. text: ${c.text}\n   source_url: ${c.source_url}\n   excerpt: ${c.excerpt}`)
    .join("\n");

  return `# STORY (Hacker News front page)
title: ${story.title}
url: ${story.url}${story.points !== undefined ? `\npoints: ${story.points}` : ""}

# SOURCES FETCHED
${sourceList}

# SOURCE-BACKED CLAIMS AVAILABLE TO YOU
Each was extracted from the source named on it. The excerpt is verbatim source text.
${claimBlock || "(none)"}

# HACKER NEWS COMMENTS
${commentBlock || "(no comments available)"}

# TASK
Write the research brief.

- "topic": the subject in a few words.
- "summary": 2-3 sentences, what happened and why it is on the front page.
- "what_it_is": plain-English, no jargon, for a viewer who has never heard of it.
- "why_it_matters": the stakes. Concrete, not "it's a game changer".
- "how_it_works": the actual mechanism, one short paragraph.
- "notable_numbers": strings like "16 years the bug went unnoticed". Only numbers that appear in the claims above. Empty array is fine.
- "skeptic_take": build this FROM THE HACKER NEWS COMMENTS. The critical and dissenting replies are the most valuable part of HN — find the strongest objection, limitation, or "this already existed" reply and state it fairly. Do not invent a criticism that no commenter made. If the comments contain no real criticism, say exactly that.
- "demo_surface": the single URL we should screen-record to show this on video, and what to show on screen. It must be one of the SOURCES FETCHED urls above.
- "claims": choose the 4 to 8 strongest claims FROM THE LIST ABOVE and copy each one's "text", "source_url" and "excerpt" fields EXACTLY as given. Do not edit the excerpt. Do not write a claim that is not in the list. Do not invent a source_url.

Return ONLY a JSON object, no prose and no markdown fence, in exactly this shape (values below are placeholders from an unrelated topic):
{
  "topic": "...",
  "summary": "...",
  "what_it_is": "...",
  "why_it_matters": "...",
  "how_it_works": "...",
  "notable_numbers": ["..."],
  "skeptic_take": "...",
  "demo_surface": {"url": "https://example.com", "what_to_show": "..."},
  "claims": [{"text": "...", "source_url": "https://example.com", "excerpt": "..."}]
}`;
}

/** Highest-scoring comments first, truncated to a character budget. HN's own
 *  ordering already puts the substantive replies near the top, but explicit
 *  score ordering keeps the budget spent on the ones people upvoted. */
function renderComments(comments: BriefComment[], budget: number): string {
  const ranked = [...comments].sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
  const parts: string[] = [];
  let used = 0;
  for (const c of ranked) {
    const body = c.text.replace(/\s+/g, " ").trim();
    if (!body) continue;
    const line = `- ${c.author ?? "anon"}: ${body}`;
    if (used + line.length > budget) {
      const room = budget - used;
      if (room > 200) parts.push(line.slice(0, room));
      break;
    }
    parts.push(line);
    used += line.length;
  }
  return parts.join("\n");
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function buildBrief(input: BuildBriefInput): Promise<BuildBriefResult> {
  const { story, comments, sources } = input;
  if (sources.length === 0) {
    throw new Error("buildBrief needs at least one successfully fetched source (PRD §3.4)");
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let calls = 0;

  // Stage 1 — one call per chunk per source, sequential. Bedrock throttles hard
  // enough on Gemma that parallelising these trades wall clock for retries.
  const candidates: BriefClaim[] = [];
  const knownUrls = new Set(sources.map((s) => s.url));
  for (const source of sources) {
    const chunks = chunk(source.text, CHUNK_CHARS, MAX_CHUNKS_PER_SOURCE);
    for (let i = 0; i < chunks.length; i++) {
      const res = await converse(
        userTurn(extractPrompt(source, chunks[i]!, i + 1, chunks.length), EXTRACT_SYSTEM),
        { maxTokens: 1500, temperature: 0 },
      );
      calls++;
      inputTokens += res.inputTokens;
      outputTokens += res.outputTokens;
      latencyMs += res.latencyMs;

      // A malformed extraction for one chunk is not fatal — the other chunks
      // still ground the brief. An empty candidate set IS fatal, below.
      let rows: RawExtract[];
      try {
        rows = parseJson<RawExtract[]>(res.text);
      } catch {
        continue;
      }
      if (!Array.isArray(rows)) continue;

      for (const row of rows) {
        if (typeof row?.text !== "string" || typeof row?.excerpt !== "string") continue;
        const text = row.text.trim();
        const excerpt = row.excerpt.trim();
        if (!text || !excerpt) continue;
        candidates.push({ text, excerpt, source_url: source.url });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `Extraction produced no candidate claims from ${sources.length} source(s) after ${calls} calls — ` +
        `refusing to synthesise an ungrounded brief (PRD §3.5)`,
    );
  }

  const shortlist = candidates.slice(0, MAX_CANDIDATE_CLAIMS);

  // Stage 2 — synthesis, with schema feedback on failure. Up to 3 attempts;
  // never a default brief (PRD §0).
  const prompt = synthPrompt({ story, comments, sources, candidates: shortlist });
  let feedback: string | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const body = feedback
      ? `${prompt}\n\n# YOUR PREVIOUS OUTPUT WAS REJECTED\n${feedback}\nReturn a corrected JSON object. Do not apologise, output JSON only.`
      : prompt;

    const res = await converse(userTurn(body, SYNTH_SYSTEM), {
      maxTokens: 3000,
      temperature: 0.2,
    });
    calls++;
    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
    latencyMs += res.latencyMs;

    try {
      const brief = ResearchBrief.parse(parseJson(res.text));

      // Structural grounding we can enforce without reading the sources again:
      // a claim citing a URL we never fetched is unverifiable by construction,
      // and the fact-checker would only reject it later at higher cost.
      const bad = brief.claims.filter((c) => !knownUrls.has(c.source_url));
      if (bad.length > 0) {
        throw new Error(
          `claims cite URLs that were not fetched: ${[...new Set(bad.map((c) => c.source_url))].join(", ")}. ` +
            `Use only these: ${[...knownUrls].join(", ")}`,
        );
      }
      if (!knownUrls.has(brief.demo_surface.url)) {
        throw new Error(
          `demo_surface.url "${brief.demo_surface.url}" was not one of the fetched sources: ${[...knownUrls].join(", ")}`,
        );
      }

      return {
        brief,
        inputTokens,
        outputTokens,
        latencyMs,
        calls,
        candidateClaims: candidates.length,
      };
    } catch (err) {
      lastError = err;
      feedback = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(
    `buildBrief failed to produce a schema-valid ResearchBrief after ${calls} calls. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
