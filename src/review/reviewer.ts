import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { converse, visionTurn, parseJson } from "../llm/bedrock.js";
import { measureLoudness, probe, sampleFrames, type LoudnessStats } from "../verify/media.js";
import { config } from "../config.js";
import { RubricScore, type ScriptJSON } from "../shared/schemas.js";

/**
 * Layer 2 of the review loop (PRD §5): a multimodal reviewer that scores a REAL
 * exported file against the approved script.
 *
 * The single most important property of this module is what it does NOT take:
 * there is no `previousReview`, no `editorLog`, no `history` parameter, and the
 * function keeps no module-level state between calls. Every review is a fresh
 * context built only from (a) frames of the real file, (b) the approved script,
 * (c) real measurements. That is what stops the loop from self-grading.
 */

export interface BeatBoundary {
  beat_id: string;
  startS: number;
  endS: number;
}

/** Just the fields of a VoiceoverClip this module needs. */
export interface MeasuredVo {
  beat_id: string;
  durationS: number;
}

/**
 * Beat boundaries are script order + ffprobe-measured VO durations laid
 * end-to-end — the same arithmetic the timeline builder uses. Never estimated:
 * a beat with no measured clip is a hard error, not a guess.
 */
export function beatBoundaries(script: ScriptJSON, voiceover: MeasuredVo[]): BeatBoundary[] {
  const byId = new Map(voiceover.map((v) => [v.beat_id, v.durationS]));
  const out: BeatBoundary[] = [];
  let t = 0;
  for (const beat of script.beats) {
    const d = byId.get(beat.id);
    if (d === undefined) {
      throw new Error(
        `Cannot compute beat boundaries: no measured voiceover for beat "${beat.id}". ` +
          `Pass the run manifest's voiceover clips (ffprobe-measured durations).`,
      );
    }
    out.push({ beat_id: beat.id, startS: t, endS: t + d });
    t += d;
  }
  return out;
}

export interface SelectedFrame {
  path: string;
  tS: number;
}

/**
 * Frame budget (documented sampling strategy).
 *
 * A 34 s video at 1 fps is 34 frames; every one of them is an image block in a
 * single Converse request. When that exceeds what the model will accept, we do
 * NOT silently drop frames — we cap N and spread the survivors evenly, while
 * pinning every beat-boundary frame so the visual-relevance dimension always
 * sees the moment each beat starts. Filling is greedy largest-gap so the
 * spacing stays as uniform as the pinned frames allow.
 */
export function selectFrames(
  framePaths: string[],
  fps: number,
  boundaries: BeatBoundary[],
  maxFrames: number,
): SelectedFrame[] {
  const n = framePaths.length;
  const at = (i: number): SelectedFrame => ({ path: framePaths[i]!, tS: i / fps });
  if (n <= maxFrames) return framePaths.map((_, i) => at(i));

  const pinned = new Set<number>();
  pinned.add(0);
  for (const b of boundaries) {
    pinned.add(Math.min(n - 1, Math.max(0, Math.floor(b.startS * fps))));
  }
  const selected = [...pinned].sort((a, b) => a - b).slice(0, maxFrames);

  while (selected.length < maxFrames) {
    // Widest gap first, including the tail after the last pinned frame.
    let bestIdx = -1;
    let bestGap = 0;
    const bounds = [...selected, n - 1 + 1];
    for (let k = 0; k < bounds.length - 1; k++) {
      const lo = bounds[k]!;
      const hi = bounds[k + 1]!;
      const mid = Math.floor((lo + hi) / 2);
      if (mid <= lo || mid > n - 1 || selected.includes(mid)) continue;
      const gap = hi - lo;
      if (gap > bestGap) {
        bestGap = gap;
        bestIdx = mid;
      }
    }
    if (bestIdx === -1) break;
    selected.push(bestIdx);
    selected.sort((a, b) => a - b);
  }

  return selected.map(at);
}

export interface ReviewInput {
  /** The real exported file. Frames are sampled from this, not from a proxy. */
  videoPath: string;
  /** The approved script (Gate A output). */
  script: ScriptJSON;
  /** Run workspace; sampled frames are written to <workspace>/review-frames. */
  workspace: string;
  /** ffprobe-measured VO durations — drives beat boundaries. */
  voiceover: MeasuredVo[];
  /**
   * Real STT transcript of the export, when the Layer-1 fidelity verifier has
   * produced one. Omitted rather than invented; the prompt says so explicitly
   * so the model doesn't assume the frames carry speech it cannot hear.
   */
  transcript?: string;
  /** Frames per second to sample. PRD §5 says ~1 fps. */
  fps?: number;
  /** Hard cap on image blocks per request. Backs off automatically if rejected. */
  maxFrames?: number;
}

export interface ReviewResult {
  rubric: RubricScore;
  frameCount: number;
  /** How many Converse calls it took to get a schema-valid rubric (1–3). */
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  loudness: LoudnessStats;
  beats: BeatBoundary[];
}

const SYSTEM = `You are a ruthless short-form video reviewer. You are shown frames from a finished 9:16 vertical video plus the script it was made from. You did not make this video and you have no memory of how it was made. Score only what you can actually observe.`;

function buildPrompt(args: {
  script: ScriptJSON;
  beats: BeatBoundary[];
  frames: SelectedFrame[];
  durationS: number;
  loudness: LoudnessStats;
  transcript?: string;
}): string {
  const { script, beats, frames, durationS, loudness, transcript } = args;
  const beatById = new Map(script.beats.map((b) => [b.id, b]));
  const beatTable = beats
    .map((b) => {
      const beat = beatById.get(b.beat_id)!;
      return [
        `- [${b.startS.toFixed(2)}s – ${b.endS.toFixed(2)}s] beat "${b.beat_id}"`,
        `  VO: ${beat.vo_text}`,
        beat.on_screen_text ? `  on-screen text: ${beat.on_screen_text}` : undefined,
        `  intended visual: ${JSON.stringify(beat.visual)}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const frameList = frames.map((f, i) => `image ${i + 1} = t=${f.tS.toFixed(2)}s`).join(", ");
  const [lo, hi] = config.loudness.acceptRange as readonly [number, number];

  return `# VIDEO UNDER REVIEW
Real exported file, ${durationS.toFixed(2)}s, ${config.video.width}x${config.video.height} @ ${config.video.fps}fps.
Topic: ${script.topic.title}

# THE ${frames.length} IMAGES
The images above are frames from this video, in chronological order:
${frameList}

# APPROVED SCRIPT (beat timings from measured voiceover durations)
${beatTable}
CTA on-screen text: ${script.cta.on_screen_text}
CTA VO: ${script.cta.vo_text}

# TRANSCRIPT
${transcript ? transcript : "NOT AVAILABLE. No speech-to-text transcript was produced for this export. Judge spoken content from the approved script above; do not claim to have heard the audio."}

# MEASURED AUDIO (you cannot hear the video — these are real ffmpeg loudnorm numbers)
integrated loudness: ${loudness.integratedLufs} LUFS (publish target ${config.loudness.targetLufs}, acceptable ${lo}..${hi})
true peak: ${loudness.truePeakDb} dBTP (must stay below -1.0)
loudness range: ${loudness.lra} LU
Score audio_mix from these numbers only. Do not speculate about music balance you cannot measure; if the only evidence is the loudness numbers, say that in the justification.

# YOUR TASK
Score six dimensions 1-5 (1 = unpublishable, 3 = mediocre, 4 = publishable, 5 = excellent):
- hook: do the first 2 seconds (t=0.00s–2.00s) stop a scroll?
- pacing: shot changes and beat lengths — dead air, rushing, or held too long?
- visual_relevance: does what is on screen in each beat's window match that beat's VO?
- caption_legibility: are burned-in captions/titles readable, correctly placed, clear of the bottom 25% and top 10% platform-UI zones?
- audio_mix: from the measured numbers above.
- coherence: does it read as one video with a beginning, middle and end?

Every dimension needs a justification of at least 20 characters that cites specific evidence (a timestamp, a frame, or a measured number).

Then list fixes. EVERY fix must name a timestamp (at_s) and a concrete action of at least 12 characters that an editor could execute without asking a follow-up question.
GOOD fixes (shape only — these refer to a DIFFERENT video, never copy their wording or timestamps):
  {"at_s": 0.0, "action": "Swap the opening still for the motion shot that appears later, so frame one already moves", "dimension": "hook"}
  {"at_s": 12.4, "action": "Raise this title to 35% of frame height, clear of the bottom platform-UI zone", "dimension": "caption_legibility"}
  {"at_s": 22.0, "action": "Trim 1.5s from this shot; nothing on screen changes across it", "dimension": "pacing"}
BAD fixes (never output these):
  {"at_s": 0, "action": "make it punchier"}          <- vague, no executable action
  {"action": "improve the visuals"}                   <- no timestamp
  {"at_s": 5, "action": "tighten"}                    <- too short, not concrete
If a dimension is fine, do not invent a fix for it. An empty fixes array is a valid answer.

# OUTPUT
Return ONLY a JSON object, no prose, no markdown fence:
{
  "scores": {
    "hook": {"score": 1-5, "justification": "..."},
    "pacing": {"score": 1-5, "justification": "..."},
    "visual_relevance": {"score": 1-5, "justification": "..."},
    "caption_legibility": {"score": 1-5, "justification": "..."},
    "audio_mix": {"score": 1-5, "justification": "..."},
    "coherence": {"score": 1-5, "justification": "..."}
  },
  "fixes": [{"at_s": number, "action": "string", "dimension": "one of the six names"}]
}`;
}

function isTooLarge(err: unknown): boolean {
  const m = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /too large|payload|exceeds|maximum|too many images|input is too long|413/i.test(m);
}

/**
 * Run one fresh multimodal review. No prior review, no editor reasoning, no
 * conversation history — by construction (see the interface above).
 */
export async function reviewVideo(input: ReviewInput): Promise<ReviewResult> {
  const { videoPath, script, workspace, voiceover, transcript } = input;
  const fps = input.fps ?? 1;

  const beats = beatBoundaries(script, voiceover);
  const info = await probe(videoPath);
  const loudness = await measureLoudness(videoPath);

  const frameDir = join(workspace, "review-frames");
  await mkdir(frameDir, { recursive: true });
  const allFrames = await sampleFrames(videoPath, frameDir, { fps, scaleWidth: 540 });
  if (allFrames.length === 0) throw new Error(`No frames sampled from ${videoPath}`);

  let cap = input.maxFrames ?? allFrames.length;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let attempts = 0;
  let feedback: string | undefined;
  let lastError: unknown;

  // Up to 3 attempts. A schema failure is fed back to the model verbatim; an
  // oversized request halves the frame cap. Neither path ever fills in a
  // default score — failing to get a valid rubric is a failure (PRD §0).
  for (let i = 0; i < 3; i++) {
    const frames = selectFrames(allFrames, fps, beats, cap);
    const prompt = buildPrompt({
      script,
      beats,
      frames,
      durationS: info.durationS,
      loudness,
      transcript,
    });
    const body = feedback
      ? `${prompt}\n\n# YOUR PREVIOUS OUTPUT WAS REJECTED BY THE SCHEMA\n${feedback}\nReturn a corrected JSON object. Do not apologise, output JSON only.`
      : prompt;

    let res;
    try {
      // Gemma has no system role; visionTurn folds it into the user turn.
      const messages = await visionTurn(frames.map((f) => f.path), body, SYSTEM);
      attempts++;
      res = await converse(messages, { maxTokens: 2048, temperature: 0.2 });
    } catch (err) {
      lastError = err;
      if (isTooLarge(err) && cap > 6) {
        cap = Math.max(6, Math.floor(cap / 2));
        feedback = undefined;
        continue;
      }
      throw err;
    }

    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
    latencyMs += res.latencyMs;

    try {
      const parsed = RubricScore.parse(parseJson(res.text));
      return {
        rubric: parsed,
        frameCount: frames.length,
        attempts,
        inputTokens,
        outputTokens,
        latencyMs,
        loudness,
        beats,
      };
    } catch (err) {
      lastError = err;
      feedback = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(
    `Reviewer failed to produce a schema-valid RubricScore after ${attempts} attempts. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
