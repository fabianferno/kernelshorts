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

export const VisualSpec = z.discriminatedUnion("type", [
  ScreenRecSpec,
  StockSpec,
  StillSpec,
]);
export type VisualSpec = z.infer<typeof VisualSpec>;

// ─── ScriptJSON (PRD §3, example schema) ────────────────────────────────────

export const Beat = z.object({
  id: z.string().min(1),
  vo_text: z.string().min(1),
  on_screen_text: z.string().optional(),
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
  kind: z.enum(["screenrec", "stock", "still", "vault"]),
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

export const AssetManifest = z.object({
  run_id: z.string(),
  assets: z.array(AcquiredAsset),
  voiceover: z.array(VoiceoverClip),
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
