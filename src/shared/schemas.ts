import { z } from "zod";

/**
 * Everything that crosses a phase boundary is validated here (PRD §2).
 * Parse at the boundary, never trust an LLM's shape.
 */

// ─── Visual plan per beat (PRD §3.8) ────────────────────────────────────────

export const ScreenRecSpec = z.object({
  type: z.literal("screenrec"),
  url: z.string().url(),
  /** mobile → 1080x1920 native vertical; desktop → 1920x1080, cropped/panned. */
  viewport: z.enum(["mobile", "desktop"]),
  /** Scripted Playwright actions, e.g. "goto", "click #demo", "scroll 600". */
  actions: z.array(z.string()).default([]),
});

export const StockSpec = z.object({
  type: z.literal("stock"),
  query: z.string().min(2),
  /** Prefer a vault asset when one matches, before hitting the stock APIs. */
  preferVault: z.boolean().default(true),
});

export const StillSpec = z.object({
  type: z.literal("still"),
  /** Absolute path or https URL of an image. */
  source: z.string().min(1),
  /** Ken Burns push over the still so it isn't a dead frame. */
  kenBurns: z.boolean().default(true),
});

/**
 * A scene we RENDER rather than find — HTML/CSS/SVG/WebGL animated in a real
 * browser and captured to video.
 *
 * This exists because of a measured failure, not a hunch. On 2026-08-13 the
 * review loop scored `visual_relevance` 2 on all four iterations of a short
 * about HTML-over-WebSockets, and re-acquiring every clip with better queries
 * ("bidirectional network connection diagram", "author's site showing 600
 * simultaneous readers") did not move it at all. The diagnosis was structural:
 * no stock library contains footage of server-rendered HTML arriving over a
 * socket. Abstract infrastructure topics — the bulk of HN's front page — have
 * no photographable referent.
 *
 * Deliberately a CLOSED set of parameterised scenes rather than free-form
 * model-authored HTML. The parameters are content the model is good at
 * (the code, the labels, the numbers); the animation, timing and typography
 * are ours and are verified once. A model writing arbitrary CSS keyframes
 * fails in ways that only show up as a blank rectangle in a finished video.
 *
 * Stock stays the default for anything with a real-world referent — a person
 * typing, a server room, a city at night. This is for the ideas.
 */
export const GeneratedScene = z.discriminatedUnion("scene", [
  z.object({
    scene: z.literal("code"),
    /** Syntax-highlighted source that types itself in. Keep it SHORT — this is
     *  a phone screen, not an IDE. */
    language: z.string().min(1).default("javascript"),
    code: z.string().min(1).max(600),
    /** 1-based lines to hold a highlight on as the beat lands. */
    highlightLines: z.array(z.number().int().positive()).default([]),
  }),
  z.object({
    scene: z.literal("terminal"),
    lines: z
      .array(
        z.object({
          command: z.string().optional(),
          output: z.string().optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
  z.object({
    scene: z.literal("diagram"),
    /** Boxes and arrows with something moving along the edges. The answer to
     *  "how do I show a protocol". */
    nodes: z.array(z.object({ id: z.string(), label: z.string() })).min(2).max(5),
    edges: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          label: z.string().optional(),
          /** Packets travel one way or bounce — a WebSocket is `both`. */
          direction: z.enum(["forward", "both"]).default("forward"),
        }),
      )
      .min(1)
      .max(6),
  }),
  z.object({
    scene: z.literal("metric"),
    /** One number, counted up, big. "600 simultaneous readers". */
    value: z.string().min(1),
    label: z.string().min(1),
    sublabel: z.string().optional(),
  }),
  z.object({
    scene: z.literal("compare"),
    left: z.object({ title: z.string(), items: z.array(z.string()).min(1).max(4) }),
    right: z.object({ title: z.string(), items: z.array(z.string()).min(1).max(4) }),
  }),
  z.object({
    scene: z.literal("particles"),
    /** A three.js field — motion and depth under a title, for beats that are
     *  atmosphere rather than information. Used sparingly: it says nothing. */
    mood: z.enum(["network", "data", "calm"]).default("network"),
  }),
]);
export type GeneratedScene = z.infer<typeof GeneratedScene>;

export const GeneratedSpec = z.object({
  type: z.literal("generated"),
  spec: GeneratedScene,
});

export const VisualSpec = z.discriminatedUnion("type", [
  ScreenRecSpec,
  StockSpec,
  StillSpec,
  GeneratedSpec,
]);
export type VisualSpec = z.infer<typeof VisualSpec>;

// ─── ScriptJSON (PRD §3, example schema) ────────────────────────────────────

/**
 * An image laid over the footage instead of (or as well as) a text title —
 * a product logo, a screenshot crop, a chart. Not every beat wants a title;
 * an image often says it better.
 */
export const OnScreenImage = z.object({
  /** https URL or absolute local path. Converted to PNG during acquisition. */
  source: z.string().min(1),
  /** Fraction of canvas width the image should occupy. */
  scale: z.number().positive().max(1).default(0.55),
  /** Vertical centre, 0–1. */
  centerY: z.number().min(0).max(1).default(0.26),
});
export type OnScreenImage = z.infer<typeof OnScreenImage>;

export const Beat = z.object({
  id: z.string().min(1),
  vo_text: z.string().min(1),
  on_screen_text: z.string().optional(),
  on_screen_image: OnScreenImage.optional(),
  visual: VisualSpec,
  /** Upper bound only. Real duration comes from the measured TTS clip. */
  max_duration_s: z.number().positive().max(20),
});
export type Beat = z.infer<typeof Beat>;

export const Claim = z.object({
  text: z.string().min(1),
  source_url: z.string().url(),
  excerpt: z.string().min(1),
});

export const ScriptJSON = z.object({
  run_id: z.string().min(1),
  topic: z.object({
    hn_id: z.number().int().optional(),
    title: z.string().min(1),
    url: z.string().url(),
  }),
  target_duration_s: z.number().min(15).max(90),
  music_mood: z.string().min(1),
  beats: z.array(Beat).min(2),
  claims: z.array(Claim).default([]),
  cta: z.object({
    vo_text: z.string().min(1),
    on_screen_text: z.string().min(1),
  }),
});
export type ScriptJSON = z.infer<typeof ScriptJSON>;

// ─── Asset manifest — what acquisition actually produced ────────────────────

export const AcquiredAsset = z.object({
  beat_id: z.string(),
  kind: z.enum(["screenrec", "stock", "still", "vault", "generated"]),
  /** Absolute local path. Palmier imports local paths synchronously (M0 §3). */
  path: z.string().min(1),
  durationS: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  sourceUrl: z.string().optional(),
  /** Licence provenance. Required for anything published. */
  license: z.object({
    provider: z.string(),
    url: z.string().optional(),
    attribution: z.string().optional(),
  }),
});
export type AcquiredAsset = z.infer<typeof AcquiredAsset>;

export const VoiceoverClip = z.object({
  beat_id: z.string(),
  path: z.string().min(1),
  /** ffprobe-measured. Drives the timeline; never estimated (PRD §3.7). */
  durationS: z.number().positive(),
  voice: z.string(),
  model: z.string(),
});
export type VoiceoverClip = z.infer<typeof VoiceoverClip>;

export const OverlayImage = z.object({
  beat_id: z.string(),
  path: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale: z.number().positive(),
  centerY: z.number(),
});
export type OverlayImage = z.infer<typeof OverlayImage>;

export const AssetManifest = z.object({
  run_id: z.string(),
  assets: z.array(AcquiredAsset),
  voiceover: z.array(VoiceoverClip),
  overlays: z.array(OverlayImage).default([]),
  music: z
    .object({
      path: z.string(),
      name: z.string(),
      loudnessLufs: z.number().optional(),
      license: z.string().optional(),
    })
    .optional(),
});
export type AssetManifest = z.infer<typeof AssetManifest>;

// ─── Review loop (PRD §5) ───────────────────────────────────────────────────

/** Layer 1: deterministic verifiers. Each reports a real measurement. */
export const VerifierResult = z.object({
  name: z.enum([
    "container",
    "loudness",
    "blackdetect",
    "freezedetect",
    "timeline_gaps",
    "caption_safe_area",
    "script_fidelity",
  ]),
  passed: z.boolean(),
  detail: z.string(),
  measured: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
});
export type VerifierResult = z.infer<typeof VerifierResult>;

const RUBRIC_DIMENSIONS = [
  "hook",
  "pacing",
  "visual_relevance",
  "caption_legibility",
  "audio_mix",
  "coherence",
] as const;

/** Vague feedback is rejected by schema (PRD §5 Layer 2): every fix names a
 *  timestamp and a concrete action. */
export const Fix = z.object({
  at_s: z.number().nonnegative(),
  action: z.string().min(12),
  dimension: z.enum(RUBRIC_DIMENSIONS),
});

export const RubricScore = z.object({
  scores: z.object(
    Object.fromEntries(
      RUBRIC_DIMENSIONS.map((d) => [
        d,
        z.object({
          score: z.number().int().min(1).max(5),
          justification: z.string().min(20),
        }),
      ]),
    ) as Record<
      (typeof RUBRIC_DIMENSIONS)[number],
      z.ZodObject<{ score: z.ZodNumber; justification: z.ZodString }>
    >,
  ),
  fixes: z.array(Fix),
});
export type RubricScore = z.infer<typeof RubricScore>;

export const RUBRIC_KEYS = RUBRIC_DIMENSIONS;

// ─── Run state + events (PRD §2) ────────────────────────────────────────────

export const RunPhase = z.enum([
  "research",
  "script",
  "tts",
  "assets",
  "edit",
  "review",
  "export",
  "publish",
  "done",
  "failed",
]);
export type RunPhase = z.infer<typeof RunPhase>;

export const GateName = z.enum(["A_script", "B_review_escalation", "C_publish"]);

export const RunState = z.object({
  run_id: z.string(),
  date_slug: z.string(),
  phase: RunPhase,
  workspace: z.string(),
  script: ScriptJSON.optional(),
  manifest: AssetManifest.optional(),
  palmier_project_path: z.string().optional(),
  iterations: z.number().int().nonnegative().default(0),
  exports: z.array(z.string()).default([]),
  /** Cost telemetry from day 1 (PRD §8). */
  telemetry: z
    .array(
      z.object({
        phase: RunPhase,
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        wallClockMs: z.number().nonnegative(),
      }),
    )
    .default([]),
  /** The recorded human decision at Gate A, so a resumed run does not have to
   *  re-ask and the dashboard can show who unblocked it and why. */
  gate_a: z
    .object({
      status: z.enum(["approved", "rejected", "superseded"]),
      comment: z.string().optional(),
      resolved_at: z.string().optional(),
    })
    .optional(),
  /**
   * Set by src/publish/record.ts when a human publishes the export by hand
   * (the API clients are deferred). Part of RunState rather than an event-feed
   * -only fact because saveState replaces the whole run document — a field
   * written outside the schema would be silently dropped on the next save.
   */
  published: z
    .object({
      platforms: z.array(z.string()).min(1),
      url: z.string(),
      title: z.string(),
      hn_id: z.number().int(),
      notes: z.string().optional(),
      published_at: z.string(),
    })
    .optional(),
  blocked_on: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type RunState = z.infer<typeof RunState>;

export const RunEvent = z.object({
  run_id: z.string(),
  ts: z.string(),
  phase: RunPhase,
  kind: z.enum(["tool_call", "log", "gate_open", "gate_closed", "error", "artifact"]),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RunEvent = z.infer<typeof RunEvent>;
