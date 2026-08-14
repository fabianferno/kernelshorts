import { z } from "zod";
import { converse, userTurn, parseJson } from "../llm/bedrock.js";
import type { ScriptJSON } from "../shared/schemas.js";

/**
 * Fact-check verifier (PRD §3.5).
 *
 * "For review-style content, a confidently wrong claim is the worst failure
 * mode; this verifier is not optional."
 *
 * The design point that matters: the *first* gate here is deterministic, not a
 * model. An excerpt either appears in the fetched source text or it does not,
 * and that is a string operation — asking a model "is this claim supported?"
 * when it can neither see the page nor be trusted to admit ignorance is how
 * you build a fact-checker that rubber-stamps hallucinations. The model is
 * used for exactly one job it is actually suited to: deciding whether a line
 * of narration is a factual assertion at all, and which verified claim it
 * rests on.
 *
 * So a claim passes in two stages:
 *   1. GROUNDING  — the excerpt is really in the source we really fetched.
 *   2. ENTAILMENT — the narration line is covered by a grounded claim.
 * A line that fails either is `unsourced`, and unsourced lines drive the
 * rewrite loop.
 */

// ─── Stage 1: grounding an excerpt in real fetched text ─────────────────────

/**
 * Normalizes text for comparison without destroying meaning.
 *
 * Models reproduce an excerpt's *words* far more reliably than its
 * *punctuation*: smart quotes become straight ones, non-breaking spaces become
 * spaces, em dashes become hyphens, and line wrapping inside a paragraph moves.
 * Comparing raw strings would fail almost every genuinely-correct excerpt, so
 * these are normalized away. Letters, digits and word order are NOT touched —
 * those are the parts that carry the fact.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/[   ]/g, " ")
    .replace(/[…]/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokens(text: string): string[] {
  return normalizeForMatch(text)
    .replace(/[^a-z0-9%$.\-\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export interface GroundingResult {
  /** Exact (post-normalization) substring hit — the strongest evidence. */
  verbatim: boolean;
  /**
   * Fraction of the excerpt's words found in a same-length window of the
   * source. Used only to explain a near miss; it never on its own passes a
   * claim, because a high word overlap with reordered words can invert a fact
   * ("outperforms" vs "is outperformed by").
   */
  coverage: number;
  detail: string;
}

/**
 * Is this excerpt really in this source text?
 *
 * Deliberately strict: only a verbatim (normalized) substring match passes.
 * The coverage number exists to make a failure diagnosable — "the model
 * paraphrased, 0.91 of the words are there" is a very different problem from
 * "the model invented this, 0.12 of the words are there" — but neither
 * paraphrase nor invention is allowed to ground a claim.
 */
export function groundExcerpt(excerpt: string, sourceText: string): GroundingResult {
  const needle = normalizeForMatch(excerpt);
  const hay = normalizeForMatch(sourceText);

  if (needle.length < 12) {
    return {
      verbatim: false,
      coverage: 0,
      detail: `excerpt too short to be evidence (${needle.length} chars after normalization)`,
    };
  }
  if (hay.includes(needle)) {
    return { verbatim: true, coverage: 1, detail: "verbatim match in fetched source text" };
  }

  const needleTokens = tokens(excerpt);
  const hayTokens = tokens(sourceText);
  const wanted = new Set(needleTokens);
  let best = 0;
  const window = needleTokens.length;
  if (window > 0 && hayTokens.length >= 1) {
    // Slide a window the size of the excerpt and count how many of its distinct
    // words appear inside. Stepping by a fraction of the window keeps this
    // linear-ish on long articles without meaningfully changing the best score.
    const step = Math.max(1, Math.floor(window / 4));
    for (let i = 0; i < hayTokens.length; i += step) {
      const slice = new Set(hayTokens.slice(i, i + window));
      let hit = 0;
      for (const w of wanted) if (slice.has(w)) hit++;
      best = Math.max(best, hit / wanted.size);
    }
  }

  return {
    verbatim: false,
    coverage: Number(best.toFixed(3)),
    detail:
      best >= 0.8
        ? `not verbatim — paraphrased (${(best * 100).toFixed(0)}% of words present nearby)`
        : `not found in source (${(best * 100).toFixed(0)}% word overlap at best)`,
  };
}

export interface SourceText {
  url: string;
  text: string;
}

export interface ClaimLike {
  text: string;
  source_url: string;
  excerpt: string;
}

export const GroundedClaim = z.object({
  text: z.string(),
  source_url: z.string(),
  excerpt: z.string(),
  grounded: z.boolean(),
  detail: z.string(),
  coverage: z.number(),
});
export type GroundedClaim = z.infer<typeof GroundedClaim>;

/**
 * Checks every claim against the text we actually downloaded.
 *
 * A claim citing a URL that was never fetched fails here rather than being
 * looked up on the fly: the set of sources is decided by the research phase,
 * and a citation that appeared from nowhere is itself the warning sign.
 */
export function groundClaims(claims: ClaimLike[], sources: SourceText[]): GroundedClaim[] {
  const byUrl = new Map(sources.map((s) => [normalizeUrl(s.url), s.text]));
  return claims.map((c) => {
    const text = byUrl.get(normalizeUrl(c.source_url));
    if (text === undefined) {
      return {
        ...c,
        grounded: false,
        coverage: 0,
        detail: `cites ${c.source_url}, which is not among the fetched sources`,
      };
    }
    const g = groundExcerpt(c.excerpt, text);
    return { ...c, grounded: g.verbatim, coverage: g.coverage, detail: g.detail };
  });
}

function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

// ─── Stage 2: does every factual line of narration rest on a grounded claim? ─

const LineVerdict = z.object({
  beat_id: z.string(),
  /** false for hooks, questions, transitions and CTAs — those assert nothing. */
  is_factual: z.boolean(),
  /** Index into the grounded-claim list, or null. */
  claim_index: z.number().int().nullable(),
  note: z.string(),
});

/**
 * Sentence openers that address the viewer instead of asserting anything:
 * questions, invitations, and calls to action. This list is short on purpose —
 * it is an exemption list, and every entry widens the hole.
 */
const NON_ASSERTIVE_OPENER =
  /^(ever\s|imagine\b|picture\b|think about\b|let me\b|let's\b|here'?s (?:what|how|why)\b|watch\b|look\b|follow\b|subscribe\b|like and\b|stay tuned\b|so[,:]?\s|but first\b)/i;

/**
 * Does this line assert something checkable, whatever the model thinks?
 *
 * This exists because the model's `is_factual` judgement is not trustworthy in
 * the permissive direction. On the first real run it marked five of seven lines
 * not_factual — including "A heat dome is high-pressure air trapping hot air"
 * and "These temperatures can be dangerous, especially for vulnerable people" —
 * because it read explanation as somehow not being assertion. Every one of
 * those is a statement that can be wrong on camera, which is the only test that
 * matters. A fact-checker whose skip-condition the model controls is not a
 * fact-checker.
 *
 * The FIRST attempt at this check listed the marks of a factual claim —
 * numbers, proper nouns, superlatives, causal verbs — and asked whether the
 * line had any. That is the wrong shape, and the tests caught it twice in a
 * row: each fix admitted the previous escapee and the next line walked
 * straight through ("The heat impacts infrastructure and can lead to drought"
 * has no number, no name, and no superlative, and is still a claim). Any list
 * of what a fact looks like will be incomplete, and in a fact-checker an
 * incomplete list is worse than none because it reads as coverage.
 *
 * So the presumption is inverted. Every sentence asserts something unless it
 * is recognisably ADDRESSED TO THE VIEWER — a question, an invitation, a call
 * to action. Those forms are few and closed; facts are not. A false positive
 * here costs one unnecessary rewrite. A false negative puts an unsourced claim
 * on camera.
 */
export function carriesVerifiableDetail(text: string): string | null {
  // A number survives any framing: "did you know it shipped 4 years ago?" is a
  // question and still a factual claim.
  if (/\d/.test(text)) return "contains a number";
  if (/[%$€£]/.test(text)) return "contains a quantity";

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    if (sentence.endsWith("?")) continue;
    if (NON_ASSERTIVE_OPENER.test(sentence)) continue;
    return `asserts something checkable ("${sentence.slice(0, 60)}")`;
  }
  return null;
}

export const FactCheckReport = z.object({
  claims: z.array(GroundedClaim),
  lines: z.array(
    z.object({
      beat_id: z.string(),
      vo_text: z.string(),
      status: z.enum(["sourced", "not_factual", "unsourced"]),
      claim: z.string().optional(),
      source_url: z.string().optional(),
      note: z.string(),
    }),
  ),
  passed: z.boolean(),
  /** Exactly what a rewrite must fix — fed back into script generation. */
  problems: z.array(z.string()),
});
export type FactCheckReport = z.infer<typeof FactCheckReport>;

export interface FactCheckInput {
  script: ScriptJSON;
  /** Claims from the research brief, with the source text they cite. */
  claims: ClaimLike[];
  sources: SourceText[];
}

/**
 * Runs both stages and returns a report the script generator can act on.
 *
 * Note what is NOT here: no confidence score, no "probably fine" band. A line
 * is sourced or it is not. A soft threshold in a fact-checker is just a slower
 * way of publishing something wrong.
 */
export async function factCheck(input: FactCheckInput): Promise<{
  report: FactCheckReport;
  inputTokens: number;
  outputTokens: number;
}> {
  const claims = groundClaims(input.claims, input.sources);
  const grounded = claims.filter((c) => c.grounded);

  const spokenLines = [
    ...input.script.beats.map((b) => ({ beat_id: b.id, vo_text: b.vo_text })),
    { beat_id: "cta", vo_text: input.script.cta.vo_text },
  ];

  // With nothing grounded there is nothing for a line to rest on, and asking
  // the model to map lines onto an empty list invites it to invent an index.
  if (grounded.length === 0) {
    const report: FactCheckReport = {
      claims,
      lines: spokenLines.map((l) => ({
        ...l,
        status: "unsourced" as const,
        note: "no claim in the research brief could be grounded in a fetched source",
      })),
      passed: false,
      problems: [
        `None of the ${claims.length} researched claim(s) could be verified against the ` +
          `fetched source text. ${claims
            .map((c) => `[${c.source_url}] ${c.detail}`)
            .slice(0, 5)
            .join("; ")}`,
      ],
    };
    return { report, inputTokens: 0, outputTokens: 0 };
  }

  const prompt =
    `Here are VERIFIED facts. Each was checked word-for-word against the ` +
    `article it cites, so you may treat them as true:\n\n` +
    grounded.map((c, i) => `[${i}] ${c.text}\n    source: ${c.source_url}`).join("\n") +
    `\n\nHere are the spoken lines of a short video script:\n\n` +
    spokenLines.map((l) => `${l.beat_id}: ${l.vo_text}`).join("\n") +
    `\n\nFor EACH line decide:\n` +
    `- is_factual: does the line assert something about the world that could be ` +
    `wrong? Hooks, questions, opinions, transitions and calls-to-action assert ` +
    `nothing — those are is_factual false.\n` +
    `- claim_index: if it IS factual, which verified fact above supports it? ` +
    `Use the number in brackets. If NO listed fact supports it, use null — ` +
    `this is the important case and you must not guess a number to be helpful.\n` +
    `- note: one short sentence of reasoning.\n\n` +
    `A line is supported only if the verified fact actually contains what the ` +
    `line says. "Roughly related topic" is not support.\n\n` +
    `Reply with JSON only, in exactly this shape:\n` +
    `{"lines":[{"beat_id":"hook","is_factual":false,"claim_index":null,` +
    `"note":"rhetorical question, asserts nothing"},` +
    `{"beat_id":"what","is_factual":true,"claim_index":2,` +
    `"note":"fact 2 states the same benchmark number"}]}`;

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await converse(
      userTurn(
        attempt === 0 ? prompt : `${prompt}\n\nYour previous reply was invalid: ${lastError}`,
        `You check whether each line of a script is supported by a list of ` +
          `verified facts. You are strict, and you answer null rather than ` +
          `guessing. You output JSON only, with no commentary.`,
      ),
      { maxTokens: 1600, temperature: 0 },
    );

    try {
      const raw = parseJson<{ lines?: unknown[] }>(res.text);
      const verdicts = new Map<string, z.infer<typeof LineVerdict>>();
      for (const item of raw.lines ?? []) {
        const parsed = LineVerdict.safeParse(item);
        if (parsed.success) verdicts.set(parsed.data.beat_id, parsed.data);
      }

      // Ask again for the lines it skipped before falling back.
      //
      // A partial verdict list used to be accepted silently, and the fallback
      // below then marked the unjudged line unsourced. That deadlocks the
      // rewrite loop: the writer is told to fix a line, rewrites it, the
      // checker skips it again, and three attempts later a real run escalated
      // on "It aims to highlight smaller, personal websites" — a line the
      // checker had never actually looked at. Re-prompting names the missing
      // beats, which is a question the model can answer.
      const unjudged = spokenLines.filter((l) => !verdicts.has(l.beat_id));
      if (unjudged.length > 0 && attempt < 2) {
        lastError =
          `you returned no verdict for: ${unjudged.map((l) => l.beat_id).join(", ")}. ` +
          `Every beat_id listed must appear exactly once in "lines".`;
        continue;
      }

      // Last attempt: the deterministic test decides, erring safe.
      const lines = spokenLines.map((l) => {
        const v = verdicts.get(l.beat_id);
        if (!v) {
          // The model routinely omits the CTA from its verdict list. Treating
          // every omission as unsourced deadlocked a real run on "Follow for
          // daily developer tools and HN insights" — a line that asserts
          // nothing and that no rewrite could ever source. Falling back to the
          // deterministic test answers it correctly and still errs safe: a line
          // that does carry a checkable detail stays unsourced.
          const detail = carriesVerifiableDetail(l.vo_text);
          return detail === null
            ? {
                ...l,
                status: "not_factual" as const,
                note: "no verdict returned; the line asserts nothing checkable",
              }
            : {
                ...l,
                status: "unsourced" as const,
                note: `no verdict returned, and the line ${detail}`,
              };
        }
        if (!v.is_factual) {
          const detail = carriesVerifiableDetail(l.vo_text);
          if (detail === null) {
            return { ...l, status: "not_factual" as const, note: v.note };
          }
          // The model tried to skip a line that plainly asserts something.
          // Overridden, and the override is recorded — a silent one would hide
          // exactly the behaviour that needs watching.
          return {
            ...l,
            status: "unsourced" as const,
            note: `checker called this non-factual, overridden: the line ${detail} — ${v.note}`,
          };
        }
        const claim = v.claim_index === null ? undefined : grounded[v.claim_index];
        if (!claim) {
          return { ...l, status: "unsourced" as const, note: v.note };
        }
        return {
          ...l,
          status: "sourced" as const,
          claim: claim.text,
          source_url: claim.source_url,
          note: v.note,
        };
      });

      if (verdicts.size === 0) {
        lastError = "no line verdicts could be parsed from the reply";
        continue;
      }

      const unsourced = lines.filter((l) => l.status === "unsourced");
      const report = FactCheckReport.parse({
        claims,
        lines,
        passed: unsourced.length === 0,
        problems: unsourced.map(
          (l) => `Beat "${l.beat_id}" states something unsupported by any verified source ` +
            `("${l.vo_text}") — ${l.note}`,
        ),
      });
      return { report, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
    } catch (err) {
      lastError = (err as Error).message.slice(0, 400);
    }
  }

  throw new Error(`Fact-check could not be completed: ${lastError}`);
}
