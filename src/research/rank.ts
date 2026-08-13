import { z } from "zod";
import { converse, userTurn, parseJson } from "../llm/bedrock.js";
import type { HnStory, HnComment } from "./hn.js";

/**
 * Phase 1 ranking (PRD §3.3): score every surviving story 1–5 on six criteria
 * with a written justification, weighted-sum to a ranked list. Top pick drives
 * the run; top 3 are shown in the dashboard.
 */

export const CriterionScores = z.object({
  /**
   * Is this a SOFTWARE / TECHNOLOGY story at all?
   *
   * Added after the first real run picked "5th Heat Dome Expands Across Europe:
   * 40C+ Target Western and Central Europe" as its top story. It scored well on
   * every other criterion — dramatic, novel, broad, low licensing risk — because
   * nothing in the rubric asked what the channel is about. HN's front page
   * carries weather, obituaries and general news, and the deterministic filter
   * in hn.ts cannot recognise those without an unmaintainable keyword list.
   * This criterion is a hard floor, not just a weight: see MIN_TOPICAL_FIT.
   */
  topical_fit: z.number().int().min(1).max(5),
  /** Can we SHOW it? A tool with a UI scores 5; a maths paper scores 1. */
  visual_demonstrability: z.number().int().min(1).max(5),
  novelty: z.number().int().min(1).max(5),
  /** Does it land outside its own niche? A kernel patch is a 2. */
  audience_breadth: z.number().int().min(1).max(5),
  /** Is there a problem → turn → payoff in it, or is it just an announcement? */
  story_arc_potential: z.number().int().min(1).max(5),
  /** Screen-recordable site, public demo, screenshots, video (PRD §3.3). */
  asset_availability: z.number().int().min(1).max(5),
  /** INVERSE: 5 = safe, 1 = licensing/controversy landmine. Stored inverted so
   *  every criterion points the same way and the weighted sum is a plain dot
   *  product with no sign special-case. */
  risk: z.number().int().min(1).max(5),
});
export type CriterionScores = z.infer<typeof CriterionScores>;

const StoryScore = CriterionScores.extend({
  hn_id: z.number().int(),
  justification: z.string().min(20),
});

/**
 * Weights sum to 1.0.
 *
 * visual_demonstrability and asset_availability dominate because they are the
 * two that decide whether the video can exist at all — a brilliant topic we
 * cannot film becomes stock footage over narration, which is the worst output
 * this pipeline produces. novelty and story_arc drive watch-through. risk is
 * weighted low but is a veto in practice: a 1 here drags a story below the
 * pack on its own.
 */
export const RANK_WEIGHTS: Readonly<Record<keyof CriterionScores, number>> = {
  visual_demonstrability: 0.24,
  asset_availability: 0.2,
  story_arc_potential: 0.16,
  novelty: 0.12,
  topical_fit: 0.12,
  audience_breadth: 0.08,
  risk: 0.08,
};

/**
 * Stories scoring below this on topical_fit are excluded outright, whatever
 * their weighted sum. A weight alone would not have saved the heat-dome run —
 * that story scored 4.06 with five strong criteria carrying one irrelevant
 * topic. Off-topic is a yes/no question, so it gets a yes/no answer.
 */
export const MIN_TOPICAL_FIT = 3;

export interface RankedStory {
  story: HnStory;
  scores: CriterionScores;
  justification: string;
  /** Weighted sum, 1.0–5.0. */
  score: number;
}

export interface UnrankedStory {
  story: HnStory;
  reason: string;
}

export interface RankResult {
  ranked: RankedStory[];
  /** Stories the model skipped or scored invalidly. Reported, never dropped. */
  unranked: UnrankedStory[];
  inputTokens: number;
  outputTokens: number;
}

export function weightedScore(s: CriterionScores): number {
  return (Object.keys(RANK_WEIGHTS) as Array<keyof CriterionScores>).reduce(
    (sum, k) => sum + s[k] * RANK_WEIGHTS[k],
    0,
  );
}

const SYSTEM =
  "You rank Hacker News stories by how well each would work as a 45-second " +
  "vertical short-form video. You output JSON only, with no commentary, no " +
  "markdown fences, and no text before or after the JSON object.";

/** Two comments per story is enough signal for "is there an argument here" and
 *  keeps a 20-story batch inside one Gemma context without truncation. */
const COMMENTS_PER_STORY = 2;
const COMMENT_CHARS_IN_PROMPT = 240;

function buildPrompt(
  stories: HnStory[],
  comments: Map<number, HnComment[]> | undefined,
  feedback: string,
): string {
  const list = stories
    .map((s) => {
      const cs = (comments?.get(s.id) ?? []).slice(0, COMMENTS_PER_STORY);
      const quoted = cs.length
        ? `\n  top comments:\n${cs
            .map((c) => `    - ${c.text.replace(/\s+/g, " ").slice(0, COMMENT_CHARS_IN_PROMPT)}`)
            .join("\n")}`
        : "";
      return (
        `- hn_id ${s.id} | ${s.points} points, ${s.num_comments} comments\n` +
        `  title: ${s.title}\n  url: ${s.url ?? "(none)"}${quoted}`
      );
    })
    .join("\n");

  return (
    `You are picking a story for a daily short-form video channel about ` +
    `SOFTWARE AND TECHNOLOGY, aimed at developers.\n\n` +
    `Score each of these ${stories.length} Hacker News stories from 1 to 5 on ` +
    `seven criteria.\n\n${list}\n\n` +
    `Criteria:\n` +
    `- topical_fit: is this a software or technology story? a developer tool, ` +
    `a language, a system, a security finding, a piece of computing history = ` +
    `5. Science or engineering with a clear computing angle = 3. General news, ` +
    `weather, politics, health, sport, business gossip, obituaries = 1, no ` +
    `matter how interesting the story is in itself\n` +
    `- visual_demonstrability: can it be SHOWN on screen? a tool with a UI we ` +
    `can screen-record = 5; a pure maths result = 1\n` +
    `- novelty: is this genuinely new, or a rehash?\n` +
    `- audience_breadth: does it interest people outside its niche?\n` +
    `- story_arc_potential: is there a problem -> turn -> payoff, or is it just ` +
    `an announcement?\n` +
    `- asset_availability: is there a public site, demo, docs or screenshots we ` +
    `can record?\n` +
    `- risk: INVERSE — 5 means LOW risk (safe, uncontroversial, no licensing ` +
    `problem), 1 means HIGH risk\n\n` +
    `Rules:\n` +
    `- Score EVERY story listed. Use its exact hn_id.\n` +
    `- Every score is an integer 1-5. Spread them out; do not give everything 4.\n` +
    `- "justification" is one or two sentences (at least 20 characters) saying ` +
    `why this would or would not make a good short.\n\n` +
    `Reply with EXACTLY this shape and nothing else:\n` +
    `{"scores":[{"hn_id":12345,"topical_fit":5,"visual_demonstrability":4,"novelty":3,` +
    `"audience_breadth":2,"story_arc_potential":4,"asset_availability":5,` +
    `"risk":5,"justification":"Live web demo we can record, and the before/after ` +
    `is obvious on screen."}]}` +
    (feedback ? `\n\nYour previous reply was rejected: ${feedback}` : "")
  );
}

/**
 * One real Bedrock call, retried up to 3 times with the validation error fed
 * back.
 *
 * Validation is PER STORY, not per batch. src/review/directives.ts learned this
 * the expensive way: one out-of-range field there used to fail the whole
 * response and, after three attempts, abort the run — discarding a dozen good
 * items over one bad number. Here a story whose score object fails is returned
 * as `unranked` and the rest still rank. Only a total washout (nothing valid at
 * all) is worth a retry.
 */
export async function rankStories(
  stories: HnStory[],
  comments?: Map<number, HnComment[]>,
): Promise<RankResult> {
  if (stories.length === 0) {
    return { ranked: [], unranked: [], inputTokens: 0, outputTokens: 0 };
  }

  const byId = new Map(stories.map((s) => [s.id, s]));
  let feedback = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await converse(userTurn(buildPrompt(stories, comments, feedback), SYSTEM), {
      // ~90 output tokens per story once the justification is written; 20
      // stories fits comfortably under this ceiling.
      maxTokens: 4096,
      temperature: 0,
    });

    let raw: unknown;
    try {
      raw = parseJson<unknown>(res.text);
    } catch (err) {
      feedback = (err as Error).message.slice(0, 300);
      continue;
    }

    // Gemma sometimes returns the bare array instead of {"scores": [...]}.
    // That is a formatting habit, not a comprehension failure — accept both
    // rather than spending a retry teaching it our wrapper key.
    const entries: unknown[] = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { scores?: unknown }).scores)
        ? ((raw as { scores: unknown[] }).scores)
        : [];

    if (entries.length === 0) {
      feedback = `expected a "scores" array of objects, got: ${JSON.stringify(raw).slice(0, 200)}`;
      continue;
    }

    const ranked: RankedStory[] = [];
    const offTopic: UnrankedStory[] = [];
    const problems: string[] = [];
    const scored = new Set<number>();

    for (const entry of entries) {
      const parsed = StoryScore.safeParse(entry);
      if (!parsed.success) {
        problems.push(
          `${JSON.stringify(entry).slice(0, 100)} → ` +
            parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "),
        );
        continue;
      }
      const story = byId.get(parsed.data.hn_id);
      if (!story) {
        problems.push(`hn_id ${parsed.data.hn_id} was not in the input list`);
        continue;
      }
      if (scored.has(story.id)) continue;
      scored.add(story.id);

      const { hn_id: _id, justification, ...scores } = parsed.data;
      if (scores.topical_fit < MIN_TOPICAL_FIT) {
        // Excluded from the ranking entirely, but reported — an off-topic story
        // that the model rated highly on everything else is exactly what a
        // human should see when they wonder why today's pick looks thin.
        offTopic.push({
          story,
          reason: `topical_fit ${scores.topical_fit} < ${MIN_TOPICAL_FIT}: ${justification}`,
        });
        continue;
      }
      ranked.push({ story, scores, justification, score: weightedScore(scores) });
    }

    if (ranked.length === 0) {
      // An all-off-topic day is a real answer, not a malformed reply — retrying
      // would just ask the model to lower its standards.
      if (offTopic.length > 0) {
        return { ranked: [], unranked: offTopic, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
      }
      feedback = problems.join(" | ").slice(0, 400);
      continue;
    }

    const unranked: UnrankedStory[] = stories
      .filter((s) => !scored.has(s.id))
      .map((story) => ({
        story,
        reason: problems.find((p) => p.includes(String(story.id)))
          ?? "the model returned no score object for this story",
      }));

    ranked.sort((a, b) => b.score - a.score);
    return {
      ranked,
      unranked: [...unranked, ...offTopic],
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    };
  }

  throw new Error(`Could not rank ${stories.length} stories after 3 attempts: ${feedback}`);
}
