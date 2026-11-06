import { config } from "../config.js";
import type { ScriptJSON, AssetManifest, AcquiredAsset } from "../shared/schemas.js";

const { fps } = config.video;

/** Breathing room between beats so cuts don't land on the VO's last syllable. */
export const BEAT_PAD_FRAMES = 4;

export interface BeatPlan {
  beatId: string;
  startFrame: number;
  endFrame: number;
  voPath: string;
  voDurationS: number;
  /** The exact words spoken — the ground truth captions must match. */
  voText: string;
  asset: AcquiredAsset;
  onScreenText?: string;
  /** Studio layout (compose `style: "studio"`) — see Beat in shared/schemas.ts. */
  chapter?: string;
  emphasis?: string[];
  sourceNote?: string;
}

/** FROZEN — the closed vocabulary src/review/directives.ts speaks. */
export interface BuildOverrides {
  captionCenterY?: number;
  captionFontSize?: number;
  beats?: Record<
    string,
    {
      /** Extra frames trimmed off the head/tail of the beat's visual. */
      trimStartFrames?: number;
      trimEndFrames?: number;
      /** Multiplier on top of the fill transform. */
      zoom?: number;
      /** Vertical focus of that zoom. */
      centerY?: number;
      /** Force a title treatment, or drop the title entirely. */
      treatment?: "boxLight" | "boxDark" | "hardShadow" | "none";
      /**
       * Cut the beat's visual into two shots at this fraction of its length,
       * the second pushed in. Beat boundaries are set by the VO and cannot
       * move, so this is the only way to add visual change inside a long beat
       * — which is what the reviewer means by "this shot is held too long".
       */
      splitAt?: number;
    }
  >;
}

const secToFrames = (s: number): number => Math.round(s * fps);

/**
 * Lays out beats end to end from measured VO durations. This is the single
 * source of truth for timing; every later step reads frames from here.
 */
export function planBeats(script: ScriptJSON, manifest: AssetManifest): BeatPlan[] {
  const plan: BeatPlan[] = [];
  let cursor = 0;

  for (const beat of script.beats) {
    const vo = manifest.voiceover.find((v) => v.beat_id === beat.id);
    if (!vo) throw new Error(`No voiceover clip for beat "${beat.id}"`);
    const asset = manifest.assets.find((a) => a.beat_id === beat.id);
    if (!asset) throw new Error(`No visual asset for beat "${beat.id}"`);

    const frames = secToFrames(vo.durationS) + BEAT_PAD_FRAMES;
    plan.push({
      beatId: beat.id,
      startFrame: cursor,
      endFrame: cursor + frames,
      voPath: vo.path,
      voDurationS: vo.durationS,
      voText: beat.vo_text,
      asset,
      onScreenText: beat.on_screen_text,
      chapter: beat.chapter,
      emphasis: beat.emphasis,
      sourceNote: beat.source_note,
    });
    cursor += frames;
  }
  return plan;
}
