import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { PalmierClient, TimelineResult } from "../palmier/client.js";
import { VerifierResult, type ScriptJSON } from "../shared/schemas.js";
import { findPlanGaps } from "./plan-gaps.js";
import type { BeatPlan } from "../edit/plan-beats.js";

const exec = promisify(execFile);

/**
 * Layer-1 deterministic verifiers that read the TIMELINE and the EXPORT
 * (PRD §5). `src/verify/media.ts` holds the ffprobe/ffmpeg container checks;
 * these three answer questions ffprobe cannot:
 *
 *   timeline_gaps      — will the render show black?
 *   caption_safe_area  — will the platform UI cover the words?
 *   script_fidelity    — does the file actually say the approved script?
 *
 * Every number below comes from a real `get_timeline` response or a real
 * Soniox transcription of a real file. Nothing is estimated except the text
 * box extent, which is explicitly documented as an estimate where it is used.
 */

// ─── shared timeline shapes ─────────────────────────────────────────────────

export interface TimelineClip {
  id?: string;
  /** `[startFrame, endFrame)` in PROJECT frames. */
  frames?: [number, number] | number[];
  mediaRef?: string;
  /** Absent for plain video clips; "text" | "image" | "audio" | "sequence". */
  mediaType?: string;
  textContent?: string;
  textStyle?: { fontSize?: number; lineSpacing?: number; [k: string]: unknown };
  transform?: { centerX?: number; centerY?: number; width?: number; height?: number };
  [k: string]: unknown;
}

export interface TimelineCaptionGroup {
  captionGroupId?: string;
  clipCount?: number;
  frameRange?: [number, number] | number[];
  textPreview?: string;
  /** Style/placement shared by every caption clip in the group. */
  shared?: TimelineClip;
  [k: string]: unknown;
}

export interface TimelineTrack {
  trackId?: string;
  index?: number;
  label?: string;
  type?: string;
  /** Empty spans, `[startFrame, endFrame)`. Absent means the track is contiguous. */
  gaps?: Array<[number, number] | number[]>;
  clips?: TimelineClip[];
  captionGroups?: TimelineCaptionGroup[];
  [k: string]: unknown;
}

/** The subset of `get_timeline` these verifiers read. */
export interface TimelineLike {
  fps?: number;
  width?: number;
  height?: number;
  totalFrames?: number;
  durationSeconds?: number;
  tracks?: TimelineTrack[];
}

const framesOf = (c: { frames?: number[] | [number, number] }): [number, number] | null => {
  const f = c.frames;
  return f && f.length >= 2 ? [Number(f[0]), Number(f[1])] : null;
};

/**
 * True when a video-type track only ever renders words — an authored text
 * track or a caption track. Gaps there are normal: not every beat carries a
 * title, and captions stop between VO phrases. Only footage tracks (video,
 * image, nested sequence) hold the picture up.
 */
function isTextOnlyTrack(track: TimelineTrack): boolean {
  if (track.captionGroups?.length) return true;
  const clips = track.clips ?? [];
  if (clips.length === 0) return true;
  return clips.every((c) => c.mediaType === "text");
}

export interface TimelineGap {
  startFrame: number;
  endFrame: number;
  startS: number;
  endS: number;
}

/**
 * Frames in `[0, totalFrames)` where NO footage track has a clip — the spans
 * that render as black.
 *
 * Palmier reports `gaps` per track, but a per-track gap is not automatically
 * black: the video zone is a stack, and a hole in an upper image track is
 * filled by whatever is under it. So this unions the covered spans across
 * every footage track and reports what the union misses, including a trailing
 * hole where footage stops before the timeline ends. Text and caption tracks
 * are excluded, as are audio tracks (silence between VO beats is expected).
 */
export function findVideoGaps(timeline: TimelineLike): TimelineGap[] {
  const fps = timeline.fps || config.video.fps;
  const total = timeline.totalFrames ?? 0;

  const spans: Array<[number, number]> = [];
  for (const track of timeline.tracks ?? []) {
    if (track.type !== "video" || isTextOnlyTrack(track)) continue;
    for (const clip of track.clips ?? []) {
      const f = framesOf(clip);
      if (f && f[1] > f[0]) spans.push(f);
    }
  }

  spans.sort((a, b) => a[0] - b[0]);
  const gaps: TimelineGap[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start > cursor) {
      gaps.push({ startFrame: cursor, endFrame: start, startS: cursor / fps, endS: start / fps });
    }
    cursor = Math.max(cursor, end);
  }
  if (total > cursor) {
    gaps.push({ startFrame: cursor, endFrame: total, startS: cursor / fps, endS: total / fps });
  }
  return gaps;
}

/**
 * PRD §5: no gaps on the video zone — a gap renders as black.
 *
 * Keeps its NAME and `VerifierResult` shape across both backends so
 * persisted rubric records stay comparable. Under `palmier` it reads the
 * live timeline exactly as before. Under `hyperframes` there is no live
 * project to read, so it delegates to `findPlanGaps`, which checks
 * `BeatPlan[]` contiguity at the BEAT layer — see the module comment in
 * `src/verify/plan-gaps.ts` for why that is a different, narrower guarantee
 * than this function's Palmier-backed check, and why it does not duplicate
 * `uncoveredIntervals()` in `src/edit/compose.ts`, which owns the shot layer.
 */
export async function checkTimelineGaps(
  clientOrPlan: PalmierClient | BeatPlan[],
): Promise<VerifierResult> {
  let gaps: TimelineGap[];
  let totalFrames: number;

  if (Array.isArray(clientOrPlan)) {
    gaps = findPlanGaps(clientOrPlan);
    totalFrames = clientOrPlan.at(-1)?.endFrame ?? 0;
  } else {
    const timeline = (await clientOrPlan.getTimeline()) as TimelineResult & TimelineLike;
    gaps = findVideoGaps(timeline);
    totalFrames = timeline.totalFrames ?? 0;
  }

  const totalGapS = gaps.reduce((sum, g) => sum + (g.endS - g.startS), 0);
  return VerifierResult.parse({
    name: "timeline_gaps",
    passed: gaps.length === 0,
    detail: gaps.length
      ? `${gaps.length} gap(s) on the video zone — these render as black: ` +
        gaps.map((g) => `${g.startS.toFixed(2)}–${g.endS.toFixed(2)}s`).join(", ")
      : "video zone is contiguous — no black gaps",
    measured: {
      gaps: gaps.length,
      totalGapS: Math.round(totalGapS * 1000) / 1000,
      totalFrames,
    },
  });
}

// ─── caption / text safe area ───────────────────────────────────────────────

/** PRD §5: keep the bottom 25% and top 10% clear of critical text. */
export const SAFE_AREA = { topClear: 0.1, bottomClear: 0.25 } as const;

/**
 * Palmier text `fontSize` is authored against a 720-tall reference canvas, so
 * one rendered line occupies about `fontSize / 720` of the frame height. That
 * constant is derived from the real project: a 46px two-line title reports a
 * box `height` of 0.127, i.e. 121.9px per line at 1920 tall — 46 × 1920/720 =
 * 122.7px.
 */
const REFERENCE_TEXT_CANVAS_H = 720;

export type SafeAreaKind = "text" | "captionGroup";

export interface SafeAreaViolation {
  id: string;
  kind: SafeAreaKind;
  zone: "top" | "bottom";
  centerY: number;
  /** Normalized 0–1 box extents used for the check. */
  top: number;
  bottom: number;
  /** How far past the safe line the box reaches, as a fraction of frame height. */
  overshoot: number;
  /** True when the extent was estimated from fontSize rather than reported. */
  estimated: boolean;
  text?: string;
}

/**
 * ESTIMATE, NOT A PIXEL MEASUREMENT. This computes where a text box probably
 * sits from the numbers Palmier reports — `transform.centerY`, `transform.height`
 * when present, otherwise `fontSize` × line count against the 720-tall
 * reference above. It does not rasterize the font, so it ignores the real
 * ascender/descender metrics of the specific typeface, the background padding,
 * outline width, drop shadow offsets, and any animation that moves the box
 * (slideUp starts the text lower than its resting position). Treat a near-miss
 * as "check the frame", and a clean pass as "no obvious overlap" rather than a
 * guarantee. Measured overshoots are typically accurate to a few percent of
 * frame height; the estimate runs slightly SMALL for single-line boxes (the
 * real 44px title above reports 0.074 against an estimated 0.061).
 */
function boxExtent(
  clip: TimelineClip,
): { top: number; bottom: number; centerY: number; estimated: boolean } | null {
  const centerY = clip.transform?.centerY;
  if (typeof centerY !== "number") return null;

  const reported = clip.transform?.height;
  if (typeof reported === "number" && reported > 0) {
    return { top: centerY - reported / 2, bottom: centerY + reported / 2, centerY, estimated: false };
  }

  const fontSize = clip.textStyle?.fontSize;
  if (typeof fontSize !== "number" || fontSize <= 0) {
    // Nothing to size the box with: fall back to the centre point, flagged as
    // an estimate so the caller knows the extremes were not checked.
    return { top: centerY, bottom: centerY, centerY, estimated: true };
  }
  const lines = Math.max(1, (clip.textContent ?? "").split("\n").length);
  const height = (lines * fontSize) / REFERENCE_TEXT_CANVAS_H;
  return { top: centerY - height / 2, bottom: centerY + height / 2, centerY, estimated: true };
}

/**
 * Every text clip and caption group whose ESTIMATED box (see `boxExtent`)
 * reaches into the top 10% or bottom 25% of the frame. A centre alone is not
 * enough — a caption centred at 0.72 with a tall font still overflows the
 * bottom band.
 */
export function findSafeAreaViolations(timeline: TimelineLike): SafeAreaViolation[] {
  const violations: SafeAreaViolation[] = [];
  const bottomLine = 1 - SAFE_AREA.bottomClear;
  const topLine = SAFE_AREA.topClear;

  const consider = (
    id: string,
    kind: SafeAreaKind,
    clip: TimelineClip,
  ): void => {
    const box = boxExtent(clip);
    if (!box) return;
    const base = {
      id,
      kind,
      centerY: box.centerY,
      top: box.top,
      bottom: box.bottom,
      estimated: box.estimated,
      ...(clip.textContent ? { text: clip.textContent } : {}),
    };
    if (box.bottom > bottomLine) {
      violations.push({ ...base, zone: "bottom", overshoot: box.bottom - bottomLine });
    }
    if (box.top < topLine) {
      violations.push({ ...base, zone: "top", overshoot: topLine - box.top });
    }
  };

  for (const track of timeline.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.mediaType !== "text") continue;
      consider(clip.id ?? "(unnamed text clip)", "text", clip);
    }
    for (const group of track.captionGroups ?? []) {
      const shared = group.shared;
      if (!shared) continue;
      consider(
        group.captionGroupId ?? "(unnamed caption group)",
        "captionGroup",
        { ...shared, textContent: shared.textContent ?? group.textPreview },
      );
    }
  }
  return violations;
}

/**
 * PRD §5: critical text keeps the bottom 25% and top 10% clear, because the
 * platforms draw their own UI there. The box extents are estimated — see
 * `boxExtent` for exactly what that estimate does and does not account for.
 */
export async function checkCaptionSafeArea(client: PalmierClient): Promise<VerifierResult> {
  const timeline = (await client.getTimeline()) as TimelineResult & TimelineLike;
  const violations = findSafeAreaViolations(timeline);
  const worst = violations.reduce<SafeAreaViolation | undefined>(
    (acc, v) => (!acc || v.overshoot > acc.overshoot ? v : acc),
    undefined,
  );
  return VerifierResult.parse({
    name: "caption_safe_area",
    passed: violations.length === 0,
    detail: violations.length
      ? `${violations.length} text element(s) reach into the reserved bands ` +
        `(top ${SAFE_AREA.topClear * 100}%, bottom ${SAFE_AREA.bottomClear * 100}%): ` +
        violations
          .map(
            (v) =>
              `${v.kind} ${v.id} centreY ${v.centerY.toFixed(3)} spans ` +
              `${v.top.toFixed(3)}–${v.bottom.toFixed(3)}, ${v.zone} overshoot ` +
              `${(v.overshoot * 100).toFixed(1)}% of frame height`,
          )
          .join("; ") +
        " (box extents are estimated, not rasterized)"
      : "all text and caption boxes clear the top 10% / bottom 25% bands (estimated extents)",
    measured: {
      violations: violations.length,
      worstOvershoot: worst ? Math.round(worst.overshoot * 1000) / 1000 : 0,
      worstElement: worst?.id ?? "none",
    },
  });
}

// ─── script fidelity ────────────────────────────────────────────────────────

export interface Divergence {
  /** Words the approved script has here. */
  expected: string;
  /** Words the export actually says here. */
  actual: string;
  /** Word index into the normalized script. */
  atScriptWord: number;
}

export interface SimilarityResult {
  ratio: number;
  scriptWords: number;
  transcriptWords: number;
  distance: number;
  biggestDivergence?: Divergence;
}

const normalizeWords = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Word-level Levenshtein similarity: `1 - distance / max(len)`, plus the
 * single largest contiguous run of edits, recovered by backtracking the DP
 * table. That run is what makes the result actionable — a missing beat shows
 * up as one long deletion, a doubled beat as one long insertion, and a
 * reordered beat as a deletion next to an insertion of the same words.
 */
export function wordSimilarity(script: string, transcript: string): SimilarityResult {
  const a = normalizeWords(script);
  const b = normalizeWords(transcript);
  const m = a.length;
  const n = b.length;

  if (m === 0 && n === 0) {
    return { ratio: 1, scriptWords: 0, transcriptWords: 0, distance: 0 };
  }

  // d[i][j] = edit distance between a[0..i) and b[0..j)
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }

  const distance = d[m]![n]!;
  const ratio = 1 - distance / Math.max(m, n);

  // Backtrack into an op list (reverse order), then group the non-matches.
  type Op = { kind: "match" | "sub" | "del" | "ins"; i: number; aw?: string; bw?: string };
  const ops: Op[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i]![j] === d[i - 1]![j - 1]) {
      ops.push({ kind: "match", i: i - 1, aw: a[i - 1], bw: b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + 1) {
      ops.push({ kind: "sub", i: i - 1, aw: a[i - 1], bw: b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      ops.push({ kind: "del", i: i - 1, aw: a[i - 1] });
      i--;
    } else {
      ops.push({ kind: "ins", i, bw: b[j - 1] });
      j--;
    }
  }
  ops.reverse();

  let best: (Divergence & { size: number }) | undefined;
  let run: Op[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const expected = run.map((o) => o.aw).filter(Boolean) as string[];
    const actual = run.map((o) => o.bw).filter(Boolean) as string[];
    const size = run.length;
    if (!best || size > best.size) {
      best = {
        size,
        expected: expected.join(" "),
        actual: actual.join(" "),
        atScriptWord: run[0]!.i,
      };
    }
    run = [];
  };
  for (const op of ops) {
    if (op.kind === "match") flush();
    else run.push(op);
  }
  flush();

  return {
    ratio,
    scriptWords: m,
    transcriptWords: n,
    distance,
    ...(best
      ? {
          biggestDivergence: {
            expected: best.expected,
            actual: best.actual,
            atScriptWord: best.atScriptWord,
          },
        }
      : {}),
  };
}

// ─── Soniox async speech-to-text ────────────────────────────────────────────

/**
 * Soniox async STT, all verified live on 2026-08-13. NOTE the host split
 * documented in src/tts/soniox.ts: TTS is on `tts-rt.soniox.com`, everything
 * here is on `api.soniox.com`.
 *
 *   1. POST   https://api.soniox.com/v1/files                multipart, field "file"
 *             → 201 {id, filename, size, created_at}
 *   2. POST   https://api.soniox.com/v1/transcriptions       {file_id, model, language_hints}
 *             → 201 {id, status, model, audio_duration_ms, error_type, error_message}
 *   3. GET    https://api.soniox.com/v1/transcriptions/{id}  poll until status "completed"
 *             → {id, status: queued|processing|completed|error, ...}
 *   4. GET    https://api.soniox.com/v1/transcriptions/{id}/transcript
 *             → {id, text, tokens:[{text, start_ms, end_ms, confidence}]}
 *             409 while the job is still running.
 *
 * The temporary file and the transcription job are deleted afterwards so a
 * daily run does not accumulate server-side state.
 */
const SONIOX_API = "https://api.soniox.com/v1";
/** `GET /v1/models` on 2026-08-13 lists v3, v4, v5 and previews in async mode; v5 is current. */
const STT_MODEL = "stt-async-v5";

async function soniox<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SONIOX_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.soniox.apiKey}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`Soniox ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface Transcript {
  text: string;
  tokens: Array<{ text: string; start_ms?: number; end_ms?: number; confidence?: number }>;
  audioDurationMs?: number;
}

/**
 * Transcribes a real media file with the real Soniox async API.
 *
 * The audio is demuxed to a mono 16 kHz m4a first — uploading a 44 MB H.264
 * master to a speech API wastes an upload for bytes the model discards.
 */
export async function transcribeFile(
  mediaPath: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<Transcript> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;

  const audioPath = join(tmpdir(), `soniox-stt-${process.pid}-${Date.now()}.m4a`);
  await exec("ffmpeg", [
    "-hide_banner", "-nostats", "-y", "-i", mediaPath,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", audioPath,
  ], { maxBuffer: 1024 * 1024 * 16 });

  let fileId: string | undefined;
  let transcriptionId: string | undefined;
  try {
    const form = new FormData();
    form.append("file", new Blob([await readFile(audioPath)]), "export-audio.m4a");
    const uploaded = await soniox<{ id: string }>("/files", { method: "POST", body: form });
    fileId = uploaded.id;

    const created = await soniox<{ id: string; status: string }>("/transcriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, model: STT_MODEL, language_hints: ["en"] }),
    });
    transcriptionId = created.id;

    const deadline = Date.now() + timeoutMs;
    let job = created as {
      id: string;
      status: string;
      error_type?: string | null;
      error_message?: string | null;
      audio_duration_ms?: number;
    };
    while (job.status !== "completed") {
      if (job.status === "error") {
        throw new Error(
          `Soniox transcription ${job.id} failed: ${job.error_type} ${job.error_message}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Soniox transcription ${job.id} still "${job.status}" after ${timeoutMs}ms — ` +
            `not treating an unfinished job as a pass.`,
        );
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      job = await soniox(`/transcriptions/${transcriptionId}`);
    }

    const transcript = await soniox<{
      text?: string;
      tokens?: Transcript["tokens"];
    }>(`/transcriptions/${transcriptionId}/transcript`);

    const tokens = transcript.tokens ?? [];
    return {
      text: transcript.text ?? tokens.map((t) => t.text).join(""),
      tokens,
      audioDurationMs: job.audio_duration_ms,
    };
  } finally {
    await unlink(audioPath).catch(() => {});
    if (transcriptionId) {
      await soniox(`/transcriptions/${transcriptionId}`, { method: "DELETE" }).catch(() => {});
    }
    if (fileId) await soniox(`/files/${fileId}`, { method: "DELETE" }).catch(() => {});
  }
}

/** PRD §5 pass mark: the export must match the approved script this closely. */
export const SCRIPT_FIDELITY_THRESHOLD = 0.9;

/**
 * The words the export is supposed to say, in order.
 *
 * Beats only. `script.cta` is metadata for the closing card, not an extra line
 * of voiceover — the pipeline authors the call to action as a final BEAT (see
 * src/m1.ts) and `build-timeline` lays out beats alone, so folding
 * `script.cta.vo_text` in as well makes the CTA appear twice and depresses the
 * similarity of a perfectly good export. The real M1 run scored 0.896 (a fail)
 * with the CTA double-counted and 0.990 without it — the single remaining edit
 * being the script's "eighteen" against the transcript's "18".
 */
export function scriptSpokenText(script: ScriptJSON): string {
  return script.beats.map((b) => b.vo_text).join(" ");
}

/**
 * PRD §5: transcript of the export ≈ the approved script's VO text.
 *
 * This is the check that catches a beat whose audio never made it into the
 * render, got doubled, or landed out of order — none of which ffprobe, black
 * detection or the timeline read can see, because the file is perfectly valid
 * either way.
 */
export async function checkScriptFidelity(
  exportPath: string,
  script: ScriptJSON,
): Promise<VerifierResult> {
  const spoken = scriptSpokenText(script);
  const transcript = await transcribeFile(exportPath);
  const sim = wordSimilarity(spoken, transcript.text);
  const passed = sim.ratio >= SCRIPT_FIDELITY_THRESHOLD;

  const divergence = sim.biggestDivergence
    ? ` Biggest divergence at script word ${sim.biggestDivergence.atScriptWord}: ` +
      `script says "${sim.biggestDivergence.expected || "(nothing)"}", ` +
      `export says "${sim.biggestDivergence.actual || "(nothing)"}".`
    : "";

  return VerifierResult.parse({
    name: "script_fidelity",
    passed,
    detail:
      `word similarity ${sim.ratio.toFixed(3)} ` +
      `(${passed ? "≥" : "<"} ${SCRIPT_FIDELITY_THRESHOLD} required); ` +
      `${sim.scriptWords} script words vs ${sim.transcriptWords} transcribed, ` +
      `${sim.distance} word edits.${divergence}`,
    measured: {
      ratio: Math.round(sim.ratio * 1000) / 1000,
      scriptWords: sim.scriptWords,
      transcriptWords: sim.transcriptWords,
      wordEdits: sim.distance,
      audioDurationMs: transcript.audioDurationMs ?? 0,
    },
  });
}
