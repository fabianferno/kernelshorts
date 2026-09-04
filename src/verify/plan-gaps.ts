import { framesToSeconds } from "../edit/units.js";
import type { BeatPlan } from "../edit/plan-beats.js";
import type { TimelineGap } from "./timeline.js";

/**
 * Layer-1 `timeline_gaps` check under the hyperframes backend — the BEAT
 * layer only.
 *
 * Under composition-from-`planBeats` this check owns contiguity of the
 * `BeatPlan[]` itself: the plan starts at frame 0, and each beat begins
 * exactly where the previous one ended. It does NOT own — and must not
 * duplicate or contradict — `uncoveredIntervals()` in `src/edit/compose.ts`,
 * which owns the SHOT layer inside each beat and is strictly stronger: Task 8
 * found that a source asset shorter than its beat left ~4.6s of black across
 * five of six beats while every beat boundary stayed perfectly contiguous. A
 * contiguous plan does not by itself prove a gapless render — that gap was
 * invisible here and only visible to `uncoveredIntervals()`. This function
 * exists to catch a different, plan-level bug: a beat boundary that overlaps
 * or leaves a hole means it drifted off the voiceover that defines it.
 */
export function findPlanGaps(plan: BeatPlan[]): TimelineGap[] {
  const gaps: TimelineGap[] = [];
  let cursor = 0;
  for (const beat of plan) {
    if (beat.startFrame !== cursor) {
      const startFrame = Math.min(cursor, beat.startFrame);
      const endFrame = Math.max(cursor, beat.startFrame);
      gaps.push({
        startFrame,
        endFrame,
        startS: framesToSeconds(startFrame),
        endS: framesToSeconds(endFrame),
      });
    }
    cursor = beat.endFrame;
  }
  return gaps;
}
