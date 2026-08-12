import type { PalmierClient } from "../palmier/client.js";
import type { BeatPlan } from "./build-timeline.js";

/**
 * Rewrites generated caption text to the script's actual words.
 *
 * Palmier builds captions by transcribing the audio, so the burned-in text is
 * whatever ASR heard. On our own TTS that is usually right and occasionally
 * wrong in an embarrassing way: a real export rendered "one Turing Tech speech
 * decides" over narration that said "one plain text page decides".
 *
 * We are not guessing at the words — the script is the source of the audio, so
 * the correct text is known exactly. Only the TIMING needs transcription. This
 * keeps every caption clip's frame range and replaces its text with the script
 * words that belong to it.
 *
 * Alignment is positional rather than fuzzy: within a beat, each caption clip
 * takes as many script words as it currently holds ASR words, in order, and the
 * final clip absorbs any remainder. ASR may split or merge a word, so a clip can
 * end up with a slightly different count than it heard; the frame range is
 * unchanged, so drift stays within one caption of the audio and never
 * accumulates across beats.
 */

interface CaptionClipRow {
  clipId: string;
  startFrame: number;
  endFrame: number;
  text: string;
}

interface CaptionGroupDetail {
  captionGroupId?: string;
  clips?: Array<[string, number, number, string]> | CaptionClipRow[];
}

function toRows(group: CaptionGroupDetail): CaptionClipRow[] {
  const clips = group.clips ?? [];
  return clips.map((c) =>
    Array.isArray(c)
      ? { clipId: c[0], startFrame: c[1], endFrame: c[2], text: c[3] }
      : c,
  );
}

export interface CorrectionResult {
  clipsChecked: number;
  clipsRewritten: number;
}

export async function correctCaptionText(
  client: PalmierClient,
  plan: BeatPlan[],
): Promise<CorrectionResult> {
  const timeline = await client.getTimeline({ captionDetail: true });

  const rows: CaptionClipRow[] = [];
  for (const track of timeline.tracks ?? []) {
    const groups = (track as { captionGroups?: CaptionGroupDetail[] }).captionGroups ?? [];
    for (const group of groups) rows.push(...toRows(group));
  }
  if (rows.length === 0) return { clipsChecked: 0, clipsRewritten: 0 };

  rows.sort((a, b) => a.startFrame - b.startFrame);

  let rewritten = 0;
  for (const beat of plan) {
    // A caption belongs to the beat it starts inside.
    const beatRows = rows.filter(
      (r) => r.startFrame >= beat.startFrame && r.startFrame < beat.endFrame,
    );
    if (beatRows.length === 0) continue;

    const scriptWords = beat.voText.split(/\s+/).filter(Boolean);
    let cursor = 0;

    for (const [i, row] of beatRows.entries()) {
      const heard = row.text.split(/\s+/).filter(Boolean).length;
      const isLast = i === beatRows.length - 1;
      const take = isLast ? scriptWords.length - cursor : Math.min(heard, scriptWords.length - cursor);
      if (take <= 0) continue;

      const corrected = scriptWords.slice(cursor, cursor + take).join(" ");
      cursor += take;

      if (corrected !== row.text) {
        await client.updateText({ clipIds: [row.clipId], content: corrected });
        rewritten++;
      }
    }
  }

  return { clipsChecked: rows.length, clipsRewritten: rewritten };
}
