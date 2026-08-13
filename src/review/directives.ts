import { z } from "zod";
import { converse, userTurn, parseJson } from "../llm/bedrock.js";
import { GeneratedScene, type RubricScore } from "../shared/schemas.js";

/**
 * Turning a reviewer's prose fixes into changes the builder can actually make.
 *
 * PRD §5 describes handing the fix list to a fresh *editor agent* that edits the
 * timeline. We build timelines deterministically instead (frame arithmetic
 * should not be delegated to a model that can hallucinate a frame number), so
 * the equivalent step is: let the model choose from a CLOSED VOCABULARY of
 * changes, then apply them exactly.
 *
 * This keeps the judgement with the model — it decides the music is too loud or
 * the hook is weak — while the mechanics stay verifiable. It also sidesteps a
 * real constraint: Gemma on Bedrock is not a reliable tool-calling model, so an
 * agentic editor driving MCP calls would be the weakest link in the loop.
 *
 * The cost of this design, stated plainly: a fix outside the vocabulary cannot
 * be applied. Those are not silently dropped — they are returned as
 * `unaddressable` and escalated to the human at Gate B, which is the honest
 * outcome for "the reviewer wants something the machine cannot do".
 */

export const Directive = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("music_level"),
    /** New music bed level in dB under the VO. */
    db: z.number().min(-40).max(-6),
    reason: z.string().min(10),
  }),
  z.object({
    kind: z.literal("caption_position"),
    /** New normalized vertical centre for captions. 0.15 still clears the
     *  top-10% safe band; below that the platform UI overlaps. */
    centerY: z.number().min(0.15).max(0.85),
    reason: z.string().min(10),
  }),
  z.object({
    kind: z.literal("caption_size"),
    fontSize: z.number().int().min(20).max(60),
    reason: z.string().min(10),
  }),
  z.object({
    kind: z.literal("beat_trim"),
    beat_id: z.string().min(1),
    /** Frames to remove from the head/tail of the beat's visual. */
    trimStartFrames: z.number().int().min(0).max(60).default(0),
    trimEndFrames: z.number().int().min(0).max(60).default(0),
    reason: z.string().min(10),
  }),
  z.object({
    kind: z.literal("beat_zoom"),
    beat_id: z.string().min(1),
    /** Multiplier applied on top of the fill transform. */
    zoom: z.number().min(1).max(4),
    centerY: z.number().min(0).max(1).default(0.5),
    reason: z.string().min(10),
  }),
  z.object({
    kind: z.literal("overlay_treatment"),
    beat_id: z.string().min(1),
    /** Force a specific title treatment when the cycled one reads badly. */
    treatment: z.enum(["boxLight", "boxDark", "hardShadow", "none"]),
    reason: z.string().min(10),
  }),
  z.object({
    kind: z.literal("beat_split"),
    beat_id: z.string().min(1),
    /**
     * Deliberately takes no position argument. An earlier version accepted a
     * cut point as a 0.2–0.8 fraction; the model supplied the review's
     * timestamp in SECONDS instead (5.03), every retry, because a number
     * called "at" next to a timestamped fix means one thing to it. The cut
     * point is not a judgement call — the builder puts it at the midpoint —
     * so removing the field removes the failure mode.
     */
    reason: z.string().min(10),
  }),
  z.object({
    kind: z.literal("replace_visual"),
    beat_id: z.string().min(1),
    /** New stock query when the current footage is irrelevant to the beat. */
    stock_query: z.string().min(3),
    reason: z.string().min(10),
  }),
  z.object({
    kind: z.literal("generate_visual"),
    beat_id: z.string().min(1),
    /**
     * The lever `replace_visual` does not have.
     *
     * On the 2026-08-13 run the reviewer scored `visual_relevance` 2 on all
     * four iterations of a short about HTML-over-WebSockets. The loop was not
     * failing to act — it re-queried the stock APIs every iteration with
     * genuinely better queries — it was pulling the only lever it had, and no
     * stock library has footage of a protocol. This gives the same fix
     * ("show the connection staying open") somewhere to land.
     *
     * Reuses the GeneratedScene contract wholesale so the reviewer's fix and
     * the script writer's choice are the same closed set of scenes, validated
     * by the same schema.
     */
    spec: GeneratedScene,
    reason: z.string().min(10),
  }),
]);
export type Directive = z.infer<typeof Directive>;

export const DirectivePlan = z.object({
  directives: z.array(Directive),
  /** Fixes the vocabulary cannot express — escalated, never silently dropped. */
  unaddressable: z.array(z.object({ at_s: z.number(), action: z.string() })).default([]),
});
export type DirectivePlan = z.infer<typeof DirectivePlan>;

const VOCABULARY_DOC = `
music_level        {db}                              music bed volume under the voice
caption_position   {centerY}                         move captions vertically (0=top, 1=bottom)
caption_size       {fontSize}                        caption font size in px at 1080x1920
beat_trim          {beat_id, trimStartFrames, trimEndFrames}   tighten a beat's visual
beat_zoom          {beat_id, zoom, centerY}          push in on a beat's footage
beat_split         {beat_id}                         cut a long beat into two shots (the
                                                      ONLY way to fix "this shot is held too
                                                      long" — beat length is fixed by the voice
                                                      over and cannot be shortened)
overlay_treatment  {beat_id, treatment}              boxLight | boxDark | hardShadow | none
replace_visual     {beat_id, stock_query}            swap in different STOCK footage. Only
                                                      works when the beat has a real-world
                                                      referent someone could have filmed
                                                      (a person typing, a server room).
generate_visual    {beat_id, spec}                    RENDER a scene for the beat instead of
                                                      finding footage. Use this — not
                                                      replace_visual — when the beat is about
                                                      an idea nobody can photograph: a
                                                      protocol, an algorithm, a benchmark
                                                      number, a tradeoff. No stock library has
                                                      footage of a protocol, so re-querying
                                                      cannot fix that beat.
  spec is ONE of:
    {"scene":"code","language":"javascript","code":"<short source, <=600 chars>","highlightLines":[2]}
    {"scene":"terminal","lines":[{"command":"npm i x"},{"output":"added 1 package"}]}
    {"scene":"diagram","nodes":[{"id":"a","label":"Browser"},{"id":"b","label":"Server"}],
                        "edges":[{"from":"a","to":"b","label":"HTML","direction":"both"}]}
    {"scene":"metric","value":"600","label":"simultaneous readers"}
    {"scene":"compare","left":{"title":"Before","items":["..."]},"right":{"title":"After","items":["..."]}}
    {"scene":"particles","mood":"network"}
`.trim();

const DIRECTIVE_KINDS = [
  "music_level", "caption_position", "caption_size",
  "beat_trim", "beat_zoom", "beat_split", "overlay_treatment", "replace_visual",
  "generate_visual",
] as const;

/**
 * Accepts the shape the model actually produces as well as the one we asked for.
 *
 * Gemma reliably emits `{"beat_trim": {beat_id, ...}}` — the kind as a wrapping
 * key — rather than the flat `{kind: "beat_trim", ...}` a discriminated union
 * needs. That is a formatting habit, not a comprehension failure: the contents
 * are correct. Rejecting it would burn retries teaching the model our JSON
 * dialect, so we normalize the wrapper away and validate the substance.
 */
function normalizePlan(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const plan = raw as { directives?: unknown[]; unaddressable?: unknown };
  if (!Array.isArray(plan.directives)) return raw;

  const directives = plan.directives.map((entry) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.kind === "string") return obj;

    const keys = Object.keys(obj);
    const kindKey = keys.find((k) => (DIRECTIVE_KINDS as readonly string[]).includes(k));
    if (!kindKey || typeof obj[kindKey] !== "object" || obj[kindKey] === null) return obj;

    const inner = obj[kindKey] as Record<string, unknown>;
    return {
      kind: kindKey,
      ...inner,
      // The nested form usually drops the reason; keep any it did supply and
      // otherwise record plainly that the model gave none, rather than
      // inventing a justification it never made.
      reason:
        typeof inner.reason === "string" && inner.reason.length >= 10
          ? inner.reason
          : typeof obj.reason === "string" && obj.reason.length >= 10
            ? obj.reason
            : "no reason supplied by the model",
    };
  });

  return { ...plan, directives };
}

export interface TranslateInput {
  rubric: RubricScore;
  beatIds: string[];
  /** Current settings so the model adjusts from reality, not from guesses. */
  current: { musicDb: number; captionCenterY: number; captionFontSize: number };
}

/**
 * Translates the reviewer's timestamped fixes into applicable directives.
 *
 * Deliberately a separate, cheap, text-only call rather than asking the vision
 * reviewer to emit directives directly: the reviewer should judge the video on
 * what it sees, not on what the builder happens to support. Coupling those
 * would teach it to only report fixable problems.
 */
export async function translateFixes(input: TranslateInput): Promise<{
  plan: DirectivePlan;
  inputTokens: number;
  outputTokens: number;
}> {
  const { rubric, beatIds, current } = input;
  if (rubric.fixes.length === 0) {
    return { plan: { directives: [], unaddressable: [] }, inputTokens: 0, outputTokens: 0 };
  }

  const prompt =
    `A video reviewer produced this fix list:\n\n` +
    rubric.fixes
      .map((f) => `- at ${f.at_s}s [${f.dimension}] ${f.action}`)
      .join("\n") +
    `\n\nBeat ids, in order: ${beatIds.join(", ")}\n` +
    `Current settings: music ${current.musicDb} dB, captions at centerY ` +
    `${current.captionCenterY}, caption font size ${current.captionFontSize}px.\n\n` +
    `Translate each fix into ONE of these directives:\n\n${VOCABULARY_DOC}\n\n` +
    `Rules:\n` +
    `- Only use the listed kinds and fields. Do not invent new ones.\n` +
    `- Beat durations are fixed by the voiceover and CANNOT be shortened. A fix\n` +
    `  asking to "trim this shot" or "hold it for less time" becomes beat_split\n` +
    `  (adds a cut so the frame changes), never beat_trim, which only changes\n` +
    `  which part of the source is shown.\n` +
    `- A fix saying the footage does not match the narration: ask yourself\n` +
    `  whether a camera could have filmed what the beat is about. If yes\n` +
    `  (a developer at a laptop, a data centre) use replace_visual. If no\n` +
    `  (a protocol, an algorithm, a benchmark result, a tradeoff) use\n` +
    `  generate_visual — re-querying stock for footage of an idea returns\n` +
    `  decorative filler and the score will not move.\n` +
    `- generate_visual content must be SHORT: this is a phone screen. Four or\n` +
    `  five lines of code, three or four boxes, one number.\n` +
    `- beat_id must be one of the ids listed above.\n` +
    `- Every directive needs a "reason" quoting the fix it addresses.\n` +
    `- If a fix cannot be expressed by ANY directive (e.g. "rewrite the script",\n` +
    `  "add a different voice"), put it in "unaddressable" instead of forcing it\n` +
    `  into a directive that does something else.\n` +
    `- Prefer few, decisive changes over many small ones.\n\n` +
    `Each directive is a FLAT object with a "kind" field naming the directive, ` +
    `its own fields, and a "reason". Do NOT nest the fields under the kind name.\n\n` +
    `Example of the exact shape required (for a DIFFERENT video — do not copy ` +
    `these values):\n` +
    `{"directives":[` +
    `{"kind":"music_level","db":-24,"reason":"reviewer said music buries the voice at 12s"},` +
    `{"kind":"beat_zoom","beat_id":"intro","zoom":1.8,"centerY":0.4,` +
    `"reason":"reviewer said the UI is too small to read at 3s"}],` +
    `"unaddressable":[{"at_s":9,"action":"rewrite the opening line"}]}`;

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await converse(
      userTurn(
        attempt === 0 ? prompt : `${prompt}\n\nYour previous reply was invalid: ${lastError}`,
        `You convert video review feedback into a fixed set of machine-applicable ` +
          `edits. You output JSON only, with no commentary.`,
      ),
      { maxTokens: 1600, temperature: 0 },
    );

    try {
      const normalized = normalizePlan(parseJson<unknown>(res.text)) as {
        directives?: unknown[];
        unaddressable?: unknown[];
      };

      // Validate EACH directive on its own. A single out-of-range field used to
      // reject the entire batch and, after three attempts, abort the run —
      // throwing away a dozen good directives over one bad number. Invalid
      // items are recorded as unaddressable so they still reach the human,
      // rather than vanishing.
      const directives: Directive[] = [];
      const rejected: Array<{ at_s: number; action: string }> = [];

      for (const raw of normalized.directives ?? []) {
        const one = Directive.safeParse(raw);
        if (!one.success) {
          rejected.push({
            at_s: 0,
            action:
              `directive rejected by schema (${JSON.stringify(raw).slice(0, 120)}): ` +
              one.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "),
          });
          continue;
        }
        if ("beat_id" in one.data && !beatIds.includes(one.data.beat_id)) {
          rejected.push({
            at_s: 0,
            action: `directive names unknown beat "${one.data.beat_id}": ${one.data.reason}`,
          });
          continue;
        }
        directives.push(one.data);
      }

      const unaddressable = z
        .array(z.object({ at_s: z.number(), action: z.string() }))
        .catch([])
        .parse(normalized.unaddressable ?? []);

      // Only a total washout is worth retrying: if the model produced nothing
      // usable at all, its next attempt gets the validation errors as feedback.
      if (directives.length === 0 && rejected.length > 0) {
        lastError = rejected.map((r) => r.action).join(" | ").slice(0, 400);
        continue;
      }

      return {
        plan: { directives, unaddressable: [...unaddressable, ...rejected] },
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      };
    } catch (err) {
      lastError = (err as Error).message.slice(0, 400);
    }
  }

  throw new Error(`Could not translate reviewer fixes into directives: ${lastError}`);
}
