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
    /**
     * Tokens the three attempts actually burned. Carried on the error because
     * a failed fact-check is one of the most expensive things this pipeline
     * does — three drafts plus three checks — and dropping the count on the
     * throw path would make escalated runs look free in the telemetry (PRD §8).
     */
    readonly inputTokens = 0,
    readonly outputTokens = 0,
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
  /**
   * The script under test. Attempt 1 drafts it; attempts 2 and 3 REPAIR the
   * failing lines of that same script rather than redrafting from scratch.
   *
   * Redrafting was the bug. A fresh draft each round is a fresh chance to
   * invent a number, and it throws away the beats that were already correctly
   * sourced. A real run burned all three attempts re-inventing "150 gigabytes"
   * from a brief that never verified it.
   */
  let candidate: ScriptJSON | undefined;

  // One initial attempt plus at most two rewrites (PRD §3.5: "max 2 loops").
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!candidate) {
      const drafted = await draftScript({ runId, story, brief, targetDurationS, feedback });
      inputTokens += drafted.inputTokens;
      outputTokens += drafted.outputTokens;
      candidate = drafted.script;
    }

    const checked = await factCheck({
      script: candidate,
      claims: brief.claims,
      sources,
    });
    inputTokens += checked.inputTokens;
    outputTokens += checked.outputTokens;

    last = { script: candidate, report: checked.report };
    if (checked.report.passed) {
      // Carry only the claims the script actually leans on into the artifact.
      // A claims list padded with facts the video never states looks like
      // sourcing while proving nothing about what was said.
      const used = new Set(
        checked.report.lines.map((l) => l.source_url).filter((u): u is string => !!u),
      );
      const script = ScriptJSON.parse({
        ...candidate,
        claims: checked.report.claims.filter((c) => c.grounded && used.has(c.source_url)),
      });
      return { script, factCheck: checked.report, attempts: attempt, inputTokens, outputTokens };
    }

    feedback = checked.report.problems;

    // Repair in place for the next pass. On the final attempt there is no next
    // pass, so nothing is spent on a repair whose result nobody would check.
    if (attempt < 3) {
      const repaired = await repairUnsourcedLines({
        script: candidate,
        report: checked.report,
        claims: brief.claims,
      });
      inputTokens += repaired.inputTokens;
      outputTokens += repaired.outputTokens;
      candidate = repaired.script;
    }
  }

  throw new UnsourceableScriptError(last!.script, last!.report, 3, inputTokens, outputTokens);
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
    // notable_numbers is DELIBERATELY not passed to the writer.
    //
    // It is an unverified extraction — no source_url, no excerpt, nothing the
    // checker can ground a line against. Handing it over as "NOTABLE NUMBERS"
    // read as an invitation, and the writer took it: a real run put "analyze
    // data up to 150 gigabytes" on camera from the entry "5 to 150 gigabytes",
    // then failed its own fact-check three times for saying it. The pipeline
    // was feeding the model numbers and then rejecting it for using them.
    // Every number that IS verified appears in the claims list below, with the
    // excerpt it came from.

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
    // Voice, and it is not a style note. A real script opened "I built a
    // search engine for $10" — the channel claiming another developer's work
    // as its own. Coming from an automated account posting daily, that is
    // misattribution at scale, and it reaches the viewer as a lie even though
    // every underlying fact was correctly sourced.
    `\n\nVOICE: you are REPORTING on work someone else did. Never write "I ` +
    `built", "we made", "my project" or anything that claims the work. Say ` +
    `"the author", "they", or the project's name. The one thing that IS ours ` +
    `is the call to action.\n` +
    // Every line being a restated fact produced two beats stating the same
    // number, one of them labelled "why it matters".
    `NO REPEATS: each beat must add something the previous beats did not. Do ` +
    `not state the same number or fact in two beats. The beat about why it ` +
    `matters must say why a developer should care, not restate what it is.\n` +
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
    `  {"type":"stock","query":"<2-4 words of imagery>"}  — footage someone ` +
    `filmed. Query something that EXISTS on a stock site: "server room", ` +
    `"typing keyboard closeup", not "the concept of novelty".\n` +
    `  {"type":"generated","spec":{...}}  — a scene we render ourselves, for ` +
    `beats about an idea with nothing to photograph. One of:\n` +
    `    {"scene":"code","language":"python","code":"<source>","highlightLines":[2]}\n` +
    `      — 4-6 SHORT lines, under 600 characters, no long identifiers. It is ` +
    `a phone screen: anything wider than ~40 characters is unreadable.\n` +
    `    {"scene":"terminal","lines":[{"command":"cargo bench"},{"output":"12ms"}]}\n` +
    `      — max 8 entries, each one line.\n` +
    `    {"scene":"diagram","nodes":[{"id":"b","label":"Browser"},` +
    `{"id":"s","label":"Server"}],"edges":[{"from":"b","to":"s",` +
    `"label":"HTML","direction":"both"}]}\n` +
    `      — 2-5 nodes, 1-6 edges, one or two words per label. ` +
    `"direction":"both" when traffic goes each way.\n` +
    `    {"scene":"metric","value":"600","label":"simultaneous readers"}\n` +
    `      — ONE number, counted up. value is short: "600", "12ms", "40%".\n` +
    `    {"scene":"compare","left":{"title":"REST","items":["2 round trips"]},` +
    `"right":{"title":"WebSocket","items":["1 open connection"]}}\n` +
    `      — max 4 items a side, 3-5 words each.\n` +
    `    {"scene":"particles","mood":"network"|"data"|"calm"}\n` +
    `      — atmosphere only; it states nothing. Use at most once, if at all.\n\n` +
    `CHOOSING THE VISUAL. Ask what the beat is about:\n` +
    `- Is there a real page or product that shows it? screenrec it. Showing ` +
    `the actual thing always beats illustrating it. "The docs site has a live ` +
    `playground" → screenrec.\n` +
    `- Is it an idea with nothing anyone could point a camera at — a protocol, ` +
    `an algorithm, an API shape, a benchmark number, a tradeoff? generated. ` +
    `"The server pushes HTML down an open socket" → a diagram scene with ` +
    `Browser and Server and a two-way edge. There is no stock footage of a ` +
    `protocol; searching for some returns blinking-router filler that has ` +
    `nothing to do with the sentence being spoken.\n` +
    `- Does it have a real-world referent someone has filmed? stock. "Teams ` +
    `spend their afternoons debugging this" → "developer at laptop night".\n\n` +
    `At least one beat MUST be a screenrec of the demo surface — showing the ` +
    `real thing is the point of the format.\n` +
    `Do NOT make every beat generated. A short where every shot is rendered ` +
    `text and boxes is an animated slide deck, not a video: it has no texture, ` +
    `no human, and nothing real in it. At most half the beats may be ` +
    `"generated", and a script that breaks that rule is rejected.\n\n` +
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
      assertVisualMix(script.beats);
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

/**
 * Caps how much of a short may be rendered rather than filmed or recorded.
 *
 * A check rather than a prompt line alone, for the same reason
 * `assertHasScreenrec` is one: the drafting loop already re-prompts with the
 * thrown message, so a violated constraint costs one call and gets fixed by
 * the model, whereas a prompt rule with nothing enforcing it is advisory and
 * silently degrades. And the failure it prevents is invisible downstream —
 * an all-generated short passes every Layer-1 verifier (right resolution,
 * no black frames, frames differ) while being an animated slide deck.
 *
 * Half, rounded up, not a fixed number: it has to hold for a 4-beat and a
 * 6-beat script. Combined with the screenrec requirement this guarantees at
 * least one recording of the real product plus at least one other shot that
 * was not rendered.
 */
export function assertVisualMix(beats: Beat[]): void {
  const generated = beats.filter((b) => b.visual.type === "generated").length;
  const cap = Math.ceil(beats.length / 2);
  if (generated > cap) {
    throw new Error(
      `${generated} of ${beats.length} beats use visual.type "generated" — at most ` +
        `${cap} may. A short that is all rendered scenes is an animated slide ` +
        `deck. Change the beats with a real-world referent to "stock" and any ` +
        `beat showing the actual product to "screenrec".`,
    );
  }
}

function assertHasScreenrec(beats: Beat[]): void {
  if (!beats.some((b) => b.visual.type === "screenrec")) {
    throw new Error(
      "no beat records the real product — at least one beat must use " +
        'visual.type "screenrec" of the demo surface',
    );
  }
}

/**
 * Rewrites ONLY the lines the fact-check rejected, leaving everything that
 * passed exactly as written.
 *
 * The loop used to redraft the whole script from scratch on every failure,
 * handing the writer a list of problems. That is why the same invented number
 * kept coming back: each attempt was a fresh draft with a fresh chance to
 * hallucinate, and the beats that were already correctly sourced were thrown
 * away and re-rolled alongside the broken one. Three attempts, three new
 * scripts, no convergence.
 *
 * Repair is the opposite: same script, one or two sentences replaced, with the
 * verified facts in front of the model and an explicit instruction that
 * deleting the claim is a valid — often the correct — answer. A line nothing
 * supports should not be reworded until it slips past the checker; it should
 * stop asserting the thing.
 */
async function repairUnsourcedLines(input: {
  script: ScriptJSON;
  report: FactCheckReport;
  claims: ResearchBrief["claims"];
}): Promise<{ script: ScriptJSON; inputTokens: number; outputTokens: number }> {
  const { script, report } = input;
  const broken = report.lines.filter((l) => l.status === "unsourced");
  if (broken.length === 0) return { script, inputTokens: 0, outputTokens: 0 };

  const prompt =
    `These are the ONLY facts you may assert. Each was checked word-for-word ` +
    `against the article it cites:\n\n` +
    report.claims
      .filter((c) => c.grounded)
      .map((c, i) => `[${i}] ${c.text}`)
      .join("\n") +
    `\n\nA script failed its fact-check. Every line below asserts something ` +
    `NO fact above supports:\n\n` +
    broken.map((l) => `${l.beat_id}: "${l.vo_text}"\n   problem: ${l.note}`).join("\n\n") +
    `\n\nRewrite ONLY these lines. For each one, in this order of preference:\n` +
    `1. If a fact above says something close, state THAT fact instead — the ` +
    `real number, the real subject.\n` +
    `2. Otherwise DELETE the unsupported assertion and keep the rest of the ` +
    `line. A shorter line is fine.\n` +
    `3. If nothing is left after deleting it, replace the line with one that ` +
    `addresses the viewer and asserts nothing — a question, or a line opening ` +
    `"Ever", "Imagine", "Here's why", "Watch", "Follow".\n\n` +
    `Do NOT invent a replacement number, date or benchmark. Do not swap one ` +
    `unsupported claim for another. Inventing a new fact here is worse than ` +
    `deleting the sentence, because it costs another whole round to catch.\n` +
    `Keep each rewritten line close to its original length — the voiceover is ` +
    `already timed against it.\n` +
    `You are REPORTING on work someone else did: never "I built" or "we made".\n\n` +
    `Reply with JSON only:\n` +
    `{"lines":[{"beat_id":"cta","vo_text":"..."}]}`;

  const res = await converse(
    userTurn(
      prompt,
      `You repair individual lines of a video script so that every factual ` +
        `sentence is one of the supplied verified facts. You prefer deleting a ` +
        `claim to inventing one. You output JSON only.`,
    ),
    { maxTokens: 1200, temperature: 0 },
  );

  const raw = parseJson<{ lines?: Array<{ beat_id?: string; vo_text?: string }> }>(res.text);
  const replacements = new Map<string, string>();
  for (const item of raw.lines ?? []) {
    if (item?.beat_id && typeof item.vo_text === "string" && item.vo_text.trim()) {
      replacements.set(item.beat_id, item.vo_text.trim());
    }
  }

  // A repair that returns nothing usable leaves the script untouched, and the
  // caller's next fact-check fails it again. That is the honest outcome: it
  // must never look like a repair happened when the text did not change.
  const repaired = ScriptJSON.parse({
    ...script,
    beats: script.beats.map((b) =>
      replacements.has(b.id) ? { ...b, vo_text: replacements.get(b.id)! } : b,
    ),
    cta: replacements.has("cta")
      ? { ...script.cta, vo_text: replacements.get("cta")! }
      : script.cta,
  });

  return { script: repaired, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
}
