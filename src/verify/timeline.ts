import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { config } from "../config.js";
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
 * Every number below comes from a real BEAT PLAN, a real browser measurement
 * of the composed project, or a real Soniox transcription of a real file —
 * nothing here is estimated. See `measureCompositionTextBoxes`.
 */
export interface TimelineGap {
  startFrame: number;
  endFrame: number;
  startS: number;
  endS: number;
}

/**
 * PRD §5: no gaps on the video zone — a gap renders as black.
 *
 * Delegates to `findPlanGaps`, which checks `BeatPlan[]` contiguity at the
 * BEAT layer — see the module comment in `src/verify/plan-gaps.ts` for why
 * that is a different, narrower guarantee than a live-timeline read would be,
 * and why it does not duplicate `uncoveredIntervals()` in
 * `src/edit/compose.ts`, which owns the shot layer.
 */
export async function checkTimelineGaps(plan: BeatPlan[]): Promise<VerifierResult> {
  const gaps = findPlanGaps(plan);
  const totalFrames = plan.at(-1)?.endFrame ?? 0;

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

export type SafeAreaKind = "text" | "captionGroup" | "title" | "caption";

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
 * A text box as MEASURED in a real browser: normalized to the frame, with
 * `top`/`bottom` taken from `getBoundingClientRect()` relative to `#root`.
 */
export interface MeasuredTextBox {
  id: string;
  kind: "title" | "caption";
  top: number;
  bottom: number;
  centerY: number;
  text: string;
}

/**
 * Reads the real geometry of every title and caption line in a composed
 * HyperFrames project, by loading its `index.html` in Chromium at the exact
 * canvas size the render uses and calling `getBoundingClientRect()`.
 *
 * WHY THIS DOES NOT SEEK. A composition is a seekable timeline and a caption
 * only PLAYS during its own window, so measuring at one instant would see one
 * caption line out of a hundred. This does not sample the playhead at all: it
 * measures LAYOUT, and in this composition layout is time-invariant by
 * construction.
 *
 *   - Every `.title` and `.caption-line` is `position: absolute` with a fixed
 *     `top` (24% / 72%, styles.ts) plus `translateY(-50%)`; none is in flow,
 *     so none can move another, and all of them can be measured at once.
 *   - The only script in the page is the composition's own GSAP timeline, and
 *     the only property it tweens is `volume` on the music `<audio>` — nothing
 *     animates a position, a size, or a font.
 *   - The HyperFrames runtime toggles a clip's VISIBILITY as the playhead
 *     crosses its window; it does not relayout it. With the runtime absent
 *     (this loads the page directly), every clip is laid out exactly where it
 *     will be painted when its window comes up.
 *
 * So ONE page load measures EVERY caption in the video rather than a sample —
 * a strictly stronger guarantee than seeking to N midpoints, which would still
 * be blind between the samples. The cost is that this would not see a future
 * change that ANIMATES text position; that would need seeking. All text CSS
 * lives in `src/edit/styles.ts`, which is where that assumption is kept true.
 *
 * Fonts matter — a title's box is the box of the real face at the real size —
 * so this waits for `document.fonts.ready`. The composition stages its own
 * faces under `assets/fonts/`, next to the html.
 */
/**
 * Runs INSIDE the page, so it is a source string rather than a closure — this
 * project's tsconfig has no "dom" lib (it is a Node pipeline), and the same
 * string form is used by src/assets/generated/layout.test.ts.
 *
 * Extents are normalized against `#root`'s own box, not the viewport, so the
 * numbers are fractions of the FRAME whatever the browser chrome does.
 */
const MEASURE_BOXES = `function () {
  var root = document.getElementById("root");
  if (!root) throw new Error("composition has no #root element");
  var frame = root.getBoundingClientRect();
  function read(selector, kind) {
    return Array.prototype.map.call(document.querySelectorAll(selector), function (el, i) {
      var r = el.getBoundingClientRect();
      return {
        id: el.id || kind + "-" + i,
        kind: kind,
        top: (r.top - frame.top) / frame.height,
        bottom: (r.bottom - frame.top) / frame.height,
        centerY: ((r.top + r.bottom) / 2 - frame.top) / frame.height,
        text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
      };
    });
  }
  return read(".title", "title").concat(read(".caption-line", "caption"));
}`;

export async function measureCompositionTextBoxes(indexPath: string): Promise<MeasuredTextBox[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: config.video.width, height: config.video.height },
      deviceScaleFactor: 1,
    });
    // Videos are irrelevant to text layout and are by far the heaviest thing
    // on the page; the pinned GSAP script is a CDN fetch that only drives
    // audio volume. Neither is allowed to make a geometry measurement slow or
    // network-dependent.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      return type === "media" || type === "script" ? route.abort() : route.continue();
    });
    await page.goto(pathToFileURL(indexPath).href, { waitUntil: "domcontentloaded" });
    await page.evaluate("document.fonts.ready");
    return (await page.evaluate(`(${MEASURE_BOXES})()`)) as MeasuredTextBox[];
  } finally {
    await browser.close();
  }
}

/** The same band test as `findSafeAreaViolations`, over MEASURED boxes. */
export function violationsFromMeasuredBoxes(boxes: MeasuredTextBox[]): SafeAreaViolation[] {
  const violations: SafeAreaViolation[] = [];
  const bottomLine = 1 - SAFE_AREA.bottomClear;
  for (const box of boxes) {
    const base = {
      id: box.id,
      kind: box.kind,
      centerY: box.centerY,
      top: box.top,
      bottom: box.bottom,
      estimated: false,
      ...(box.text ? { text: box.text } : {}),
    };
    if (box.bottom > bottomLine) {
      violations.push({ ...base, zone: "bottom", overshoot: box.bottom - bottomLine });
    }
    if (box.top < SAFE_AREA.topClear) {
      violations.push({ ...base, zone: "top", overshoot: SAFE_AREA.topClear - box.top });
    }
  }
  return violations;
}

/**
 * A composed HyperFrames project. `indexPath` is the composition's
 * `index.html`.
 */
export interface ComposedProject {
  indexPath: string;
}

/**
 * PRD §5: critical text keeps the bottom 25% and top 10% clear, because the
 * platforms draw their own UI there.
 *
 * MEASURES the real DOM in a real browser at the real canvas size
 * (`measureCompositionTextBoxes`). Nothing is estimated: the box is the box
 * the renderer paints.
 */
export async function checkCaptionSafeArea(source: ComposedProject): Promise<VerifierResult> {
  const boxes = await measureCompositionTextBoxes(source.indexPath);
  if (boxes.length === 0) {
    throw new Error(
      `caption_safe_area found no .title or .caption-line elements in ` +
        `${source.indexPath} — refusing to report a pass it did not measure.`,
    );
  }
  const violations = violationsFromMeasuredBoxes(boxes);
  const elements = boxes.length;

  const worst = violations.reduce<SafeAreaViolation | undefined>(
    (acc, v) => (!acc || v.overshoot > acc.overshoot ? v : acc),
    undefined,
  );
  const provenance = `measured in a browser at ${config.video.width}x${config.video.height}`;
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
        ` (${provenance})`
      : `all ${elements} text and caption boxes clear the top ${SAFE_AREA.topClear * 100}% / ` +
        `bottom ${SAFE_AREA.bottomClear * 100}% bands (${provenance})`,
    measured: {
      violations: violations.length,
      elements,
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
 * src/m1.ts) and the builder lays out beats alone, so folding
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
