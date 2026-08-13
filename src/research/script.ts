import { ScriptJSON, type Beat } from "../shared/schemas.js";
import { converse, userTurn, parseJson } from "../llm/bedrock.js";
import { factCheck, type SourceText, type FactCheckReport } from "./factcheck.js";
import type { ResearchBrief } from "./brief.js";

/**
 * Script generation with the fact-check rewrite loop (PRD §3.5–3.6).
 *
 * Two rewrites, then escalate. The cap is deliberate: a model that has failed
 * to source a line twice is not one attempt away from succeeding — it is
 * asserting something it has no evidence for, and the right response is a human
 * looking at it, not a third roll of the dice.
 */

/**
 * Words per second of finished narration, measured from real Soniox tts-rt-v2
 * output in M1: the six-beat script ran 2.6 wps including the pauses the model
 * inserts at sentence ends. Used only to size the ASK — the real durations come
 * from ffprobe on the rendered clips, never from this number (PRD §3.7).
 */
export const WORDS_PER_SECOND = 2.6;

export interface GenerateScriptInput {
  runId: string;
  /** The HN story itself. The brief's own `topic` is a one-line label, not the
   *  canonical record — the id and URL that go on the artifact come from here. */
  story: { hn_id?: number; title: string; url: string };
  brief: ResearchBrief;
  sources: SourceText[];
  targetDurationS: number;
}

export interface GenerateScriptResult {
  script: ScriptJSON;
  factCheck: FactCheckReport;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Thrown when the script cannot be made sourceable. Carries the last attempt
 * and its report so Gate B can show a human exactly which line failed and why,
 * rather than just "script generation failed".
 */
export class UnsourceableScriptError extends Error {
  constructor(
    readonly script: ScriptJSON,
    readonly report: FactCheckReport,
    readonly attempts: number,
  ) {
    super(
      `Script still has ${report.problems.length} unsourced line(s) after ` +
        `${attempts} attempt(s):\n${report.problems.join("\n")}`,
    );
    this.name = "UnsourceableScriptError";
  }
}

export async function generateScript(
  input: GenerateScriptInput,
): Promise<GenerateScriptResult> {
  const { runId, story, brief, sources, targetDurationS } = input;
  let inputTokens = 0;
  let outputTokens = 0;
  let feedback: string[] = [];
  let last: { script: ScriptJSON; report: FactCheckReport } | undefined;

  // One initial attempt plus at most two rewrites (PRD §3.5: "max 2 loops").
  for (let attempt = 1; attempt <= 3; attempt++) {
    const drafted = await draftScript({ runId, story, brief, targetDurationS, feedback });
    inputTokens += drafted.inputTokens;
    outputTokens += drafted.outputTokens;

    const checked = await factCheck({
      script: drafted.script,
      claims: brief.claims,
      sources,
    });
    inputTokens += checked.inputTokens;
    outputTokens += checked.outputTokens;

    last = { script: drafted.script, report: checked.report };
    if (checked.report.passed) {
      // Carry only the claims the script actually leans on into the artifact.
      // A claims list padded with facts the video never states looks like
      // sourcing while proving nothing about what was said.
      const used = new Set(
        checked.report.lines.map((l) => l.source_url).filter((u): u is string => !!u),
      );
      const script = ScriptJSON.parse({
        ...drafted.script,
        claims: checked.report.claims.filter((c) => c.grounded && used.has(c.source_url)),
      });
      return { script, factCheck: checked.report, attempts: attempt, inputTokens, outputTokens };
    }

    feedback = checked.report.problems;
  }

  throw new UnsourceableScriptError(last!.script, last!.report, 3);
}

// ─── Drafting one candidate ─────────────────────────────────────────────────

interface DraftInput {
  runId: string;
  story: { hn_id?: number; title: string; url: string };
  brief: ResearchBrief;
  targetDurationS: number;
  feedback: string[];
}

async function draftScript(input: DraftInput): Promise<{
  script: ScriptJSON;
  inputTokens: number;
  outputTokens: number;
}> {
  const { runId, story, brief, targetDurationS, feedback } = input;
  const wordBudget = Math.round(targetDurationS * WORDS_PER_SECOND);

  const base =
    `Write a ${targetDurationS}-second vertical short about this topic.\n\n` +
    `TOPIC: ${story.title}\n${story.url}\n\n` +
    `WHAT IT IS: ${brief.what_it_is}\n` +
    `WHY IT MATTERS: ${brief.why_it_matters}\n` +
    `HOW IT WORKS: ${brief.how_it_works}\n` +
    (brief.notable_numbers.length
      ? `NOTABLE NUMBERS: ${brief.notable_numbers.join("; ")}\n`
      : "") +
    // Marked unverified on purpose. The skeptic take is synthesised from the
    // comment thread as prose, so it carries no excerpt and cannot ground a
    // line. Handing it over unlabelled is what made a real run deadlock: the
    // writer kept opening its catch beat with "some developers question the
    // need for Delta", which no verified claim supported and no rewrite could
    // fix. Claims extracted FROM the discussion page are labelled below, and
    // those are the sourceable way to say the same thing.
    `WHAT HN IS SKEPTICAL ABOUT (background only — NOT verified, do not state ` +
    `any of this as fact unless a verified claim below also says it): ` +
    `${brief.skeptic_take}\n` +
    `DEMO SURFACE: ${brief.demo_surface.url} — ${brief.demo_surface.what_to_show}\n\n` +
    `VERIFIED FACTS. Every factual sentence you write must be one of these, ` +
    `restated in plainer words. Do not add facts, numbers, dates, company ` +
    `names, benchmark results or version numbers that are not here — an ` +
    `unsupported claim gets the script rejected:\n` +
    brief.claims
      .map((c, i) => {
        const fromDiscussion = /news\.ycombinator\.com/.test(c.source_url);
        return `[${i}]${fromDiscussion ? " (from the HN discussion)" : ""} ${c.text}`;
      })
      .join("\n") +
    // The checker's rule, stated to the writer. Without this the hook fails
    // almost every time: a writer told "be surprising" opens with a confident
    // assertion nobody sourced, and only finds out after the rewrite loop has
    // burned its two attempts. The rule is not "avoid facts" — it is "every
    // sentence is either one of the facts above, or is addressed to the viewer".
    `\n\nHARD RULE, checked automatically after you write: EVERY sentence must ` +
    `be either (a) one of the verified facts above, restated, or (b) addressed ` +
    `to the viewer and asserting nothing — a question, or a line starting with ` +
    `"Ever", "Imagine", "Here's why", "Watch", "Follow". A sentence that is ` +
    `neither gets the whole script rejected. This applies to the hook and the ` +
    `CTA exactly as much as to the middle.\n` +
    `So: "Chrome renders it differently — here's why" only works if a fact ` +
    `above says that. "Ever noticed your icons look wrong?" always works.\n` +
    `\n\nSTRUCTURE: 4 to 6 beats plus a CTA.\n` +
    `- The FIRST beat is the hook and must earn the first two seconds: a ` +
    `surprising concrete detail or a sharp question. Never "let's talk about".\n` +
    `- Then what it is, why it matters, and how it works.\n` +
    `- Include an honest catch — a limitation or objection — ONLY if a verified ` +
    `claim above supports one (the ones marked "from the HN discussion" usually ` +
    `do). A short honest catch is what makes this worth watching, but an ` +
    `invented one gets the script rejected. If nothing above supports a ` +
    `criticism, leave it out and end on how it works.\n` +
    `- Total spoken words across all beats plus the CTA: about ${wordBudget}. ` +
    `Each beat is one or two spoken sentences.\n\n` +
    `EACH BEAT NEEDS A VISUAL, one of:\n` +
    `  {"type":"screenrec","url":"<https url>","viewport":"mobile"|"desktop",` +
    `"actions":["goto","wait 900","scroll 700"]}  — a real page we can record. ` +
    `Use this for the demo surface; the actions list is literally what a ` +
    `browser will do, so keep it to goto / wait <ms> / scroll <px> / click <css>.\n` +
    `  {"type":"stock","query":"<2-4 words of imagery>"}  — for abstract beats. ` +
    `Query real footage that exists on a stock site: "server room", "typing ` +
    `keyboard closeup", not "the concept of novelty".\n` +
    `At least one beat MUST be a screenrec of the demo surface — showing the ` +
    `real thing is the point of the format.\n\n` +
    `on_screen_text is OPTIONAL and short (2-5 words, no full sentences). Leave ` +
    `it off entirely for at least one beat so the screen can breathe.\n\n` +
    `Reply with JSON only, exactly this shape:\n` +
    `{"target_duration_s":${targetDurationS},"music_mood":"upbeat-tech",` +
    `"beats":[{"id":"hook","vo_text":"...","on_screen_text":"...",` +
    `"visual":{"type":"screenrec","url":"https://example.com","viewport":"mobile",` +
    `"actions":["goto","wait 900","scroll 600"]},"max_duration_s":6}],` +
    `"cta":{"vo_text":"...","on_screen_text":"Follow for daily HN finds"}}`;

  const prompt = feedback.length
    ? `${base}\n\nYour previous script was REJECTED by a fact-checker. Fix ` +
      `exactly these lines — either restate them so they match a verified fact ` +
      `above, or cut the unsupported detail entirely. Do not defend them:\n` +
      feedback.map((p) => `- ${p}`).join("\n")
    : base;

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await converse(
      userTurn(
        attempt === 0 ? prompt : `${prompt}\n\nYour previous reply was invalid: ${lastError}`,
        `You write tight, concrete short-form video scripts for a developer ` +
          `audience. You never invent facts. You output JSON only, with no ` +
          `commentary.`,
      ),
      { maxTokens: 2200, temperature: 0.4 },
    );

    try {
      const raw = parseJson<Record<string, unknown>>(res.text);
      const script = ScriptJSON.parse({
        ...raw,
        run_id: runId,
        topic: { hn_id: story.hn_id, title: story.title, url: story.url },
        target_duration_s: targetDurationS,
        beats: normalizeBeats(raw.beats, brief.demo_surface.url),
        claims: [],
      });
      assertHasScreenrec(script.beats);
      return { script, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
    } catch (err) {
      lastError = (err as Error).message.slice(0, 500);
    }
  }
  throw new Error(`Could not draft a valid script: ${lastError}`);
}

/**
 * Repairs the shape mistakes the model makes consistently, and only those.
 *
 * Anything here is a formatting habit with an unambiguous correction — a
 * missing id, a duration expressed as a string. Judgement calls (which visual,
 * what the line says) are never repaired; those come back as validation errors
 * so the model fixes them itself.
 */
function normalizeBeats(raw: unknown, demoUrl: string): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const beat = { ...(entry as Record<string, unknown>) };
    if (typeof beat.id !== "string" || !beat.id) beat.id = i === 0 ? "hook" : `beat${i + 1}`;
    if (typeof beat.max_duration_s === "string") beat.max_duration_s = Number(beat.max_duration_s);
    if (typeof beat.max_duration_s !== "number" || !Number.isFinite(beat.max_duration_s)) {
      beat.max_duration_s = 8;
    }
    // An empty on_screen_text passes `.optional()` but renders an empty title
    // clip on the timeline, which the builder then treats as a real overlay.
    if (typeof beat.on_screen_text === "string" && beat.on_screen_text.trim() === "") {
      delete beat.on_screen_text;
    }
    const visual = beat.visual as Record<string, unknown> | undefined;
    if (visual && visual.type === "screenrec") {
      // The model sometimes writes a bare domain or a placeholder for the URL
      // it was given verbatim in the brief. Only substitute when what it wrote
      // is not a usable https URL at all.
      const url = typeof visual.url === "string" ? visual.url : "";
      if (!/^https?:\/\/.+\..+/.test(url)) visual.url = demoUrl;
      if (!Array.isArray(visual.actions)) visual.actions = ["goto", "wait 1200", "scroll 700"];
      if (visual.viewport !== "mobile" && visual.viewport !== "desktop") {
        visual.viewport = "mobile";
      }
    }
    return beat;
  });
}

function assertHasScreenrec(beats: Beat[]): void {
  if (!beats.some((b) => b.visual.type === "screenrec")) {
    throw new Error(
      "no beat records the real product — at least one beat must use " +
        'visual.type "screenrec" of the demo surface',
    );
  }
}
