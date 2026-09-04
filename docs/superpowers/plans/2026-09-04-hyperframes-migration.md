# HyperFrames Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Palmier Pro (a desktop NLE driven over local MCP) with HyperFrames (HTML-to-video) so the kernelshorts pipeline runs headless with no application open.

**Architecture:** `planBeats` stays as the pure, VO-measured source of timing truth. A new `compose()` turns `BeatPlan[]` into a HyperFrames composition directory (`index.html` + assets), and `render()` renders it headlessly via the HyperFrames CLI. The imperative Palmier middle — media imports, track indices, canvas re-assertion, caption correction — is deleted rather than ported.

**Tech Stack:** TypeScript (ESM, `type: "module"`), Node `node:test` + `node:assert/strict`, `tsx`, pnpm, `@hyperframes/cli` (invoked via `npx hyperframes`), GSAP 3.14.2 (CDN, in-composition), ffmpeg/ffprobe (already used).

**Spec:** `docs/superpowers/specs/2026-09-04-hyperframes-migration-design.md`

## Global Constraints

- **pnpm only.** Never `npm`. The two run commands are `pnpm server` and `pnpm dev`. Tests: `pnpm test`. Types: `pnpm typecheck`.
- **Canvas is 1080x1920 at 30fps.** From `src/config.ts:112` — `config.video = { width: 1080, height: 1920, fps: 30 }`. Read these from `config`, never hardcode.
- **HyperFrames times in SECONDS; kernelshorts plans in FRAMES.** Every `data-start` / `data-duration` is `frames / config.video.fps`. Never write a frame number into the HTML.
- **`data-volume` is LINEAR gain, not dB.** kernelshorts speaks dB (`musicDuckDb` default `-20`, source-audio mute `-60`). Convert with `10 ** (db / 20)`.
- **Clip windows are half-open `[start, start + duration)`.** Back-to-back beats (`b.start === a.start + a.duration`) produce no overlapping frame. `planBeats` already lays beats out contiguously, so this maps exactly.
- **No fallback branches (PRD §0).** A missing credential, font, or asset halts the run with the real error. Never degrade to a mock or a silent default.
- **PRD §0 also governs measurement:** never estimate a duration. Every number comes from a real ffprobe measurement made during acquisition.
- **`BuildOverrides` is frozen.** Do not add, rename, or remove fields. It is the closed vocabulary `src/review/directives.ts` speaks.

### HyperFrames composition rules that cause silent failures

These are from the `hyperframes-core` skill. Violating them produces a broken render, sometimes with no error:

- Root `<div>` needs `data-composition-id`, `data-width`, `data-height`, and an explicit sized box in CSS (`width: 1080px; height: 1920px`). Without the pixel box, children collapse to the top-left corner.
- Exactly one `gsap.timeline({ paused: true })`, registered at `window.__timelines["<data-composition-id>"]` after it is fully built.
- **Every `<audio>` MUST have an `id`.** The mixer selects `audio[id][src]`; an id-less `<audio>` is never mixed and **the render is silent**.
- Video must be `muted` and `playsinline`. Audio is always a separate `<audio>` element, even when it shares the source file.
- **Never nest a `<video data-start>` inside another element that also has `data-start`.** Lint errors `video_nested_in_timed_element`, and the clip shows wrong source frames then vanishes. Put timing on the wrapper **or** the media, never both.
- Never put `crossorigin` on `<video>`/`<audio>` (lint error, no suppression).
- Never pair a CSS initial `transform` with a GSAP tween on the same property (lint error `gsap_css_transform_conflict`). Use `gsap.fromTo()`.
- Never tween `display` or `visibility` on a clip element; use `autoAlpha`.
- No render-time clocks, no unseeded `Math.random`, no network, no `repeat: -1`.
- Untimed full-bleed elements (no `data-start`) get **no** automatic layout — they need their own `position: absolute; inset: 0` or they collapse to zero height.
- A lint **error** switches off the layout and contrast audits, so `check` reports `0 sample(s)` and looks clean while nothing ran. Clear lint errors before trusting `check`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/edit/plan-beats.ts` | `BeatPlan`, `planBeats`. Pure. Moved verbatim from `build-timeline.ts`. |
| `src/edit/units.ts` | `framesToSeconds`, `dbToGain`. Pure. The two unit conversions the whole backend depends on. |
| `src/edit/styles.ts` | Title treatments, variant cycle, `splitLines`, `needsScrim`, and the composition's CSS. |
| `src/edit/captions.ts` | Word timings → caption DOM with active-word highlight. |
| `src/edit/compose.ts` | `BeatPlan[]` + `BuildOverrides` → composition directory. |
| `src/edit/render.ts` | `npx hyperframes render` wrapper → mp4. |
| `src/edit/build.ts` | Orchestrates compose + render, returns `BuildResult`. |
| `src/verify/plan-gaps.ts` | `findPlanGaps` — contiguity/overlap assertions on `BeatPlan[]`. |

Deleted in Task 11: `src/palmier/client.ts`, `src/palmier/client.test.ts`, `src/edit/correct-captions.ts`, `src/edit/scrim.ts`, `src/edit/build-timeline.ts`, `src/edit/text-styles.ts`.

---

# PHASE 1 — Extract the pure core

## Task 1: Extract `planBeats` into its own module

Palmier still runs after this task. No behavior changes. This exists so the timing core has tests before anything else moves.

**Files:**
- Create: `src/edit/plan-beats.ts`
- Create: `src/edit/plan-beats.test.ts`
- Modify: `src/edit/build-timeline.ts` (delete `BeatPlan`/`planBeats`/`BuildOverrides`, re-export from the new module)

**Note:** `BuildOverrides` moves here too. It currently lives in `build-timeline.ts`, which Task 11 deletes, and `compose.ts` needs it — so it must land in a surviving module now rather than be moved twice.

**Interfaces:**
- Consumes: `ScriptJSON`, `AssetManifest`, `AcquiredAsset` from `../shared/schemas.js`; `config` from `../config.js`
- Produces:
  ```ts
  export interface BeatPlan {
    beatId: string; startFrame: number; endFrame: number;
    voPath: string; voDurationS: number; voText: string;
    asset: AcquiredAsset; onScreenText?: string;
  }
  export const BEAT_PAD_FRAMES: number;               // 4
  export function planBeats(script: ScriptJSON, manifest: AssetManifest): BeatPlan[];

  /** FROZEN — the closed vocabulary src/review/directives.ts speaks. */
  export interface BuildOverrides {
    captionCenterY?: number;
    captionFontSize?: number;
    beats?: Record<string, {
      trimStartFrames?: number; trimEndFrames?: number;
      zoom?: number; centerY?: number;
      treatment?: "boxLight" | "boxDark" | "hardShadow" | "none";
      splitAt?: number;
    }>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/edit/plan-beats.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { planBeats, BEAT_PAD_FRAMES } from "./plan-beats.js";
import type { ScriptJSON, AssetManifest } from "../shared/schemas.js";

/** Minimal fixtures — only the fields planBeats reads. */
const script = {
  run_id: "test-run",
  beats: [
    { id: "hook", vo_text: "First line.", on_screen_text: "HOOK" },
    { id: "body", vo_text: "Second line.", on_screen_text: undefined },
  ],
} as unknown as ScriptJSON;

const manifest = {
  voiceover: [
    { beat_id: "hook", path: "/vo/hook.wav", durationS: 2 },
    { beat_id: "body", path: "/vo/body.wav", durationS: 3 },
  ],
  assets: [
    { beat_id: "hook", path: "/v/a.mp4", kind: "stock", width: 1280, height: 720, durationS: 10 },
    { beat_id: "body", path: "/v/b.mp4", kind: "screenrec", width: 1280, height: 720, durationS: 10 },
  ],
  overlays: [],
} as unknown as AssetManifest;

test("beats are laid out contiguously, each padded by BEAT_PAD_FRAMES", () => {
  const plan = planBeats(script, manifest);
  assert.equal(plan.length, 2);
  // 2s at 30fps = 60 frames, + 4 pad = 64
  assert.deepEqual(
    plan.map((p) => [p.startFrame, p.endFrame]),
    [[0, 60 + BEAT_PAD_FRAMES], [64, 64 + 90 + BEAT_PAD_FRAMES]],
  );
});

test("each beat ends exactly where the next begins — no gap, no overlap", () => {
  const plan = planBeats(script, manifest);
  for (let i = 1; i < plan.length; i++) {
    assert.equal(plan[i]!.startFrame, plan[i - 1]!.endFrame);
  }
});

test("the plan carries the spoken words through for caption ground truth", () => {
  const plan = planBeats(script, manifest);
  assert.equal(plan[0]!.voText, "First line.");
  assert.equal(plan[0]!.onScreenText, "HOOK");
});

test("a beat with no voiceover is a hard error, not a skipped beat", () => {
  const broken = { ...script, beats: [...script.beats, { id: "orphan", vo_text: "x" }] } as ScriptJSON;
  assert.throws(() => planBeats(broken, manifest), /No voiceover clip for beat "orphan"/);
});

test("a beat with no visual asset is a hard error", () => {
  const noAsset = {
    ...manifest,
    assets: manifest.assets.filter((a) => a.beat_id !== "body"),
  } as AssetManifest;
  assert.throws(() => planBeats(script, noAsset), /No visual asset for beat "body"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/edit/plan-beats.test.ts`
Expected: FAIL — cannot resolve `./plan-beats.js`.

- [ ] **Step 3: Create the module**

Create `src/edit/plan-beats.ts` by moving the existing code verbatim out of `src/edit/build-timeline.ts`. Do not change the logic:

```ts
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
    });
    cursor += frames;
  }
  return plan;
}
```

- [ ] **Step 4: Re-export from `build-timeline.ts` so nothing else breaks**

In `src/edit/build-timeline.ts`, delete the `BEAT_PAD_FRAMES` constant, the `BeatPlan` interface, the `secToFrames` helper, and the `planBeats` function. Add near the top:

```ts
import { planBeats, type BeatPlan, type BuildOverrides } from "./plan-beats.js";
export { planBeats, BEAT_PAD_FRAMES, type BeatPlan, type BuildOverrides } from "./plan-beats.js";
```

Move the `BuildOverrides` interface across verbatim, comments included — it is
frozen, and its comments explain why `splitAt` exists (beat boundaries are set
by the VO and cannot move, so splitting is the only way to add visual change
inside a long beat).

Leave `fillTransform` where it is — it dies in Task 11, and Palmier still needs it until then.

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/edit/plan-beats.ts src/edit/plan-beats.test.ts src/edit/build-timeline.ts
git commit -m "Extract planBeats into its own tested module

The timing core is pure arithmetic over ffprobe-measured durations and
survives the HyperFrames migration unchanged. Give it tests before it
moves. No behavior change; build-timeline re-exports it."
```

---

# PHASE 2 — Build the HyperFrames path

Tasks 2-6 produce modules behind a flag. Palmier remains the default until Task 10. **Tasks 3, 4, and 6 are independent of each other** and can be dispatched to parallel subagents once Task 2 lands.

## Task 2: Unit conversions

Small but foundational — every other Phase 2 task consumes it, so it lands alone and first.

**Files:**
- Create: `src/edit/units.ts`
- Create: `src/edit/units.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function framesToSeconds(frames: number): number;
  export function dbToGain(db: number): number;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/edit/units.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { framesToSeconds, dbToGain } from "./units.js";

test("frames convert to seconds at the project frame rate", () => {
  assert.equal(framesToSeconds(0), 0);
  assert.equal(framesToSeconds(30), 1);
  assert.equal(framesToSeconds(45), 1.5);
});

test("frame conversion is rounded to microseconds, not left as float noise", () => {
  // 64 / 30 = 2.1333333333333333 — must not serialize 17 digits into the HTML.
  assert.equal(framesToSeconds(64), 2.133333);
});

test("dB converts to linear gain", () => {
  assert.equal(dbToGain(0), 1);
  // -20 dB is exactly a tenth of the amplitude.
  assert.equal(dbToGain(-20), 0.1);
  // -6 dB is roughly half.
  assert.ok(Math.abs(dbToGain(-6) - 0.501187) < 1e-6);
});

test("the source-audio mute level is effectively silent but not negative", () => {
  const muted = dbToGain(-60);
  assert.ok(muted > 0);
  assert.ok(muted < 0.002);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/edit/units.test.ts`
Expected: FAIL — cannot resolve `./units.js`.

- [ ] **Step 3: Implement**

Create `src/edit/units.ts`:

```ts
import { config } from "../config.js";

/**
 * The two unit conversions the HyperFrames backend depends on.
 *
 * kernelshorts plans in FRAMES and speaks audio in dB, because that is what an
 * NLE and ffmpeg speak. A HyperFrames composition times in SECONDS and takes
 * LINEAR gain in `data-volume`. Getting either wrong is silent: a frame number
 * written into `data-start` renders a 64-second clip, and a dB value written
 * into `data-volume` is clamped to a boost.
 */

const { fps } = config.video;

/**
 * Rounded to microseconds so the emitted HTML stays readable and diffable.
 * At 30fps one microsecond is 3e-5 of a frame, far below anything the renderer
 * can resolve, so this is lossless in practice.
 */
export function framesToSeconds(frames: number): number {
  return Math.round((frames / fps) * 1e6) / 1e6;
}

/** dB to linear amplitude. 0 dB is unity, -20 dB is a tenth, -60 dB is silence. */
export function dbToGain(db: number): number {
  return Math.round(10 ** (db / 20) * 1e6) / 1e6;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec tsx --test src/edit/units.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edit/units.ts src/edit/units.test.ts
git commit -m "Add frame/second and dB/gain conversions for the HyperFrames backend

HyperFrames times in seconds and takes linear gain; kernelshorts plans in
frames and speaks dB. Both mistakes are silent in a render, so isolate and
test the conversions."
```

---

## Task 3: Composition styles and title treatments

Port `src/edit/text-styles.ts` from Palmier text-clip arguments to CSS + DOM. **Read `src/edit/text-styles.ts` in full before starting** — the variant cycle, font choices, and `needsScrim` rules are tuned and must carry over by value.

**Files:**
- Create: `src/edit/styles.ts`
- Create: `src/edit/styles.test.ts`
- Read (do not modify): `src/edit/text-styles.ts`

**Interfaces:**
- Consumes: `framesToSeconds` from `./units.js`
- Produces:
  ```ts
  export type Treatment = "boxLight" | "boxDark" | "hardShadow" | "none";
  export function splitLines(text: string, perLine?: number): string[];
  export function needsScrim(index: number, forced?: Treatment): boolean;
  export function treatmentForIndex(index: number, forced?: Treatment): Treatment;
  /** The <style> block for the whole composition. */
  export function compositionCss(opts: { width: number; height: number; fontFaces: string }): string;
  /** The title element for one beat, or "" when the beat has no title. */
  export function titleHtml(opts: {
    beatId: string; text: string | undefined;
    startS: number; durationS: number; treatment: Treatment;
  }): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/edit/styles.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { splitLines, needsScrim, treatmentForIndex, titleHtml, compositionCss } from "./styles.js";

test("titles wrap at the configured words per line", () => {
  assert.deepEqual(splitLines("one two three four five", 3), ["one two three", "four five"]);
});

test("a forced treatment of none never asks for a scrim", () => {
  assert.equal(needsScrim(0, "none"), false);
});

test("a boxed treatment needs no scrim; a bare one does", () => {
  assert.equal(needsScrim(0, "boxLight"), false);
  assert.equal(needsScrim(0, "hardShadow"), true);
});

test("the treatment cycles across beats so one short does not repeat a look", () => {
  const cycle = [0, 1, 2, 3].map((i) => treatmentForIndex(i));
  assert.ok(new Set(cycle).size > 1, "expected the variant cycle to vary");
});

test("a forced treatment overrides the cycle", () => {
  assert.equal(treatmentForIndex(1, "boxDark"), "boxDark");
});

test("a beat with no title renders no element at all", () => {
  assert.equal(
    titleHtml({ beatId: "hook", text: undefined, startS: 0, durationS: 2, treatment: "boxLight" }),
    "",
  );
  assert.equal(
    titleHtml({ beatId: "hook", text: "X", startS: 0, durationS: 2, treatment: "none" }),
    "",
  );
});

test("a title carries its timing in seconds and is marked as a clip", () => {
  const html = titleHtml({
    beatId: "hook", text: "HELLO", startS: 1.5, durationS: 2.25, treatment: "boxLight",
  });
  assert.match(html, /data-start="1\.5"/);
  assert.match(html, /data-duration="2\.25"/);
  assert.match(html, /class="[^"]*clip/);
  assert.match(html, /id="title-hook"/);
  assert.match(html, /HELLO/);
});

test("title text is HTML-escaped so a script never reaches the composition", () => {
  const html = titleHtml({
    beatId: "x", text: "<script>alert(1)</script>", startS: 0, durationS: 1, treatment: "boxLight",
  });
  assert.ok(!html.includes("<script>"), "raw script tag leaked into the composition");
  assert.match(html, /&lt;script&gt;/);
});

test("the composition CSS sizes the root box in explicit pixels", () => {
  const css = compositionCss({ width: 1080, height: 1920, fontFaces: "" });
  assert.match(css, /width:\s*1080px/);
  assert.match(css, /height:\s*1920px/);
  // Untimed full-bleed elements need their own positioning or they collapse.
  assert.match(css, /\.clip\s*\{[^}]*position:\s*absolute/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/edit/styles.test.ts`
Expected: FAIL — cannot resolve `./styles.js`.

- [ ] **Step 3: Implement `src/edit/styles.ts`**

Port the constants from `text-styles.ts` by value. The structure:

```ts
import { FONTS, CAPTION_FONT, VARIANT_CYCLE } from "./text-styles.js"; // read these, then inline them
```

Do **not** import from `text-styles.ts` in the shipped module — it is deleted in Task 11. Copy the tuned values across. Requirements:

- `escapeHtml(s)` — escape `&`, `<`, `>`, `"` before any interpolation. Every text value from the script passes through it.
- `treatmentForIndex(index, forced)` — returns `forced` when given, else indexes `VARIANT_CYCLE` modulo its length, matching `text-styles.ts`.
- `needsScrim(index, forced)` — same predicate as `text-styles.ts:115`. A boxed treatment paints its own background, so only bare treatments need the gradient behind them.
- `titleHtml` — returns `""` when `text` is falsy or `treatment === "none"`. Otherwise a `<div class="clip title title--<treatment>" id="title-<beatId>" data-start data-duration>` containing one `<span class="title-line">` per `splitLines` entry. No `<br>` (banned by the determinism rules).
- `compositionCss` — emits the `<style>` body: `body { margin: 0 }`, `#root { position: relative; width: <w>px; height: <h>px; overflow: hidden; background: #000 }`, `.clip { position: absolute; inset: 0 }`, `.beat-video { width: 100%; height: 100%; object-fit: cover }` (this is what replaces `fillTransform`), the scrim gradient, the three title treatments, and the caption styles. Interpolate `fontFaces` where the `@font-face` rules go.
- Title vertical placement must respect `SAFE_AREA` from `src/verify/timeline.ts:160` — `topClear: 0.1`, `bottomClear: 0.25`. Titles sit between those bounds.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec tsx --test src/edit/styles.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edit/styles.ts src/edit/styles.test.ts
git commit -m "Port title treatments and composition CSS to HyperFrames

The variant cycle, scrim predicate, and line splitting carry over by
value; what changes is the output — CSS and DOM instead of Palmier
add_texts arguments. object-fit: cover replaces fillTransform's
reciprocal-scale math entirely."
```

---

## Task 4: Captions from word timings

The script produced the audio, so the **words are already known** and come from `beat.voText`. Only the per-word **timings** are unknown. This deletes the need for `src/edit/correct-captions.ts`.

**Files:**
- Create: `src/edit/captions.ts`
- Create: `src/edit/captions.test.ts`

**Interfaces:**
- Consumes: `BeatPlan` from `./plan-beats.js`; `framesToSeconds` from `./units.js`
- Produces:
  ```ts
  export interface WordTiming { word: string; startS: number; endS: number }
  /** Aligns known words to timings measured from the beat's own VO file. */
  export function alignWords(voText: string, timings: WordTiming[], voDurationS: number): WordTiming[];
  export function captionsHtml(opts: {
    beatId: string; startFrame: number; words: WordTiming[];
    centerY?: number; fontSize?: number;
  }): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/edit/captions.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { alignWords, captionsHtml, type WordTiming } from "./captions.js";

const timings: WordTiming[] = [
  { word: "hacker", startS: 0.0, endS: 0.4 },
  { word: "news", startS: 0.4, endS: 0.9 },
];

test("words come from the script, timings come from the transcriber", () => {
  // The transcriber misheard "Hacker News" as "hacker noose" — the script wins.
  const heard: WordTiming[] = [
    { word: "hacker", startS: 0.0, endS: 0.4 },
    { word: "noose", startS: 0.4, endS: 0.9 },
  ];
  const aligned = alignWords("Hacker News", heard, 1);
  assert.deepEqual(aligned.map((w) => w.word), ["Hacker", "News"]);
  assert.deepEqual(aligned.map((w) => w.startS), [0.0, 0.4]);
});

test("a transcriber that returns fewer words than the script still covers every word", () => {
  const aligned = alignWords("one two three four", timings, 2);
  assert.equal(aligned.length, 4);
  // Every word has a non-zero window and they are monotonic.
  for (let i = 0; i < aligned.length; i++) {
    assert.ok(aligned[i]!.endS > aligned[i]!.startS, `word ${i} has an empty window`);
    if (i > 0) assert.ok(aligned[i]!.startS >= aligned[i - 1]!.startS);
  }
  // The last word ends no later than the measured VO duration.
  assert.ok(aligned.at(-1)!.endS <= 2 + 1e-9);
});

test("no timings at all distributes words across the measured duration", () => {
  const aligned = alignWords("one two three four", [], 2);
  assert.equal(aligned.length, 4);
  assert.equal(aligned[0]!.startS, 0);
  assert.ok(Math.abs(aligned.at(-1)!.endS - 2) < 1e-6);
});

test("caption timings are rebased onto the beat's global start", () => {
  // Beat starts at frame 60 = 2s, so a word at 0.4s local is 2.4s global.
  const html = captionsHtml({ beatId: "hook", startFrame: 60, words: timings });
  assert.match(html, /data-start="2"/);
  assert.match(html, /data-start="2\.4"/);
});

test("each caption word is its own timed clip with an id", () => {
  const html = captionsHtml({ beatId: "hook", startFrame: 0, words: timings });
  assert.match(html, /id="cap-hook-0"/);
  assert.match(html, /id="cap-hook-1"/);
  assert.match(html, /hacker/);
  assert.match(html, /news/);
});

test("caption words are HTML-escaped", () => {
  const html = captionsHtml({
    beatId: "x", startFrame: 0,
    words: [{ word: "<b>", startS: 0, endS: 1 }],
  });
  assert.ok(!html.includes("<b>"));
  assert.match(html, /&lt;b&gt;/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/edit/captions.test.ts`
Expected: FAIL — cannot resolve `./captions.js`.

- [ ] **Step 3: Implement `src/edit/captions.ts`**

Requirements:

- `alignWords(voText, timings, voDurationS)`: tokenize `voText` on whitespace — **these tokens are the output words, always**. Walk them against `timings` positionally. When a timing exists at that index, take its `startS`/`endS`. When the script has more words than the transcriber returned, distribute the remaining words evenly across the span from the last known timing to `voDurationS`. When `timings` is empty, distribute all words evenly across `voDurationS`. Guarantee: output length equals the script's word count, windows are non-empty and monotonic, and nothing exceeds `voDurationS`.
- `captionsHtml`: one `<span class="clip caption-word" id="cap-<beatId>-<i>" data-start data-duration>` per word, with timings rebased by `framesToSeconds(startFrame)`. Escape every word. Apply `centerY` / `fontSize` overrides as inline style when provided (these are `BuildOverrides.captionCenterY` and `captionFontSize`).
- The active-word highlight is CSS: the caption container shows the full line, and the current word gets a highlight class. Since Palmier's two-layer stroke hack is gone, the ordinary words carry a stroke via `-webkit-text-stroke` and the highlighted word overrides it — one DOM, two classes.

Add a short module comment explaining that the words are never transcribed content, only timed, and that this is why `correct-captions.ts` no longer exists.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec tsx --test src/edit/captions.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edit/captions.ts src/edit/captions.test.ts
git commit -m "Caption words from the script, timings from the transcriber

Palmier transcribed the VO and correct-captions.ts rewrote the result
against the script. The script produced the audio, so only timings were
ever unknown. Words now come from beat.voText by construction and an ASR
mishearing can no longer reach the render."
```

---

## Task 5: The composition writer

The heart of the migration. Turns a `BeatPlan[]` into a renderable project directory.

**Files:**
- Create: `src/edit/compose.ts`
- Create: `src/edit/compose.test.ts`
- Read (do not modify): `src/edit/build-timeline.ts` — the assembly order and tuned constants live there.

**Interfaces:**
- Consumes: `BeatPlan` (Task 1), `framesToSeconds`/`dbToGain` (Task 2), `titleHtml`/`compositionCss`/`treatmentForIndex`/`needsScrim` (Task 3), `captionsHtml`/`alignWords`/`WordTiming` (Task 4), `BuildOverrides` from `./plan-beats.js`
- Produces:
  ```ts
  export interface ComposeOptions {
    plan: BeatPlan[];
    manifest: AssetManifest;
    projectDir: string;
    runId: string;
    musicDuckDb?: number;          // default -20
    overrides?: BuildOverrides;
    wordTimings?: Map<string, WordTiming[]>;  // beatId -> timings
  }
  export interface ComposeResult { projectDir: string; indexPath: string; totalSeconds: number }
  export async function compose(opts: ComposeOptions): Promise<ComposeResult>;
  /** Exposed for tests: builds the HTML without touching the filesystem. */
  export function composeHtml(opts: ComposeOptions): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/edit/compose.test.ts`. This is a golden-structure test, not a golden-string test — assert on the properties that matter:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { composeHtml } from "./compose.js";
import type { BeatPlan } from "./plan-beats.js";
import type { AssetManifest } from "../shared/schemas.js";

const plan: BeatPlan[] = [
  {
    beatId: "hook", startFrame: 0, endFrame: 64,
    voPath: "/vo/hook.wav", voDurationS: 2, voText: "First line here.",
    asset: { beat_id: "hook", path: "/v/a.mp4", kind: "stock", width: 1280, height: 720, durationS: 10 } as never,
    onScreenText: "HOOK",
  },
  {
    beatId: "body", startFrame: 64, endFrame: 158,
    voPath: "/vo/body.wav", voDurationS: 3, voText: "Second line here.",
    asset: { beat_id: "body", path: "/v/b.mp4", kind: "screenrec", width: 1280, height: 720, durationS: 10 } as never,
    onScreenText: undefined,
  },
];

const manifest = { voiceover: [], assets: [], overlays: [], music: { name: "bed", path: "/m/bed.mp3" } } as unknown as AssetManifest;

const base = { plan, manifest, projectDir: "/tmp/p", runId: "test-run" };

test("the root declares the project canvas and a duration in seconds", () => {
  const html = composeHtml(base);
  assert.match(html, /data-composition-id="kernelshorts"/);
  assert.match(html, /data-width="1080"/);
  assert.match(html, /data-height="1920"/);
  // 158 frames at 30fps = 5.266667s
  assert.match(html, /data-duration="5\.266667"/);
});

test("exactly one paused GSAP timeline is registered under the composition id", () => {
  const html = composeHtml(base);
  assert.equal(html.match(/gsap\.timeline\(/g)?.length, 1);
  assert.match(html, /paused:\s*true/);
  assert.match(html, /window\.__timelines\["kernelshorts"\]/);
});

test("every audio element has an id — an id-less one renders silent", () => {
  const html = composeHtml(base);
  const audioTags = html.match(/<audio[^>]*>/g) ?? [];
  assert.ok(audioTags.length >= 3, "expected two VO tracks and a music bed");
  for (const tag of audioTags) assert.match(tag, /\sid="/, `audio without id: ${tag}`);
});

test("videos are muted and inline, and carry no crossorigin", () => {
  const html = composeHtml(base);
  const videoTags = html.match(/<video[^>]*>/g) ?? [];
  assert.equal(videoTags.length, 2);
  for (const tag of videoTags) {
    assert.match(tag, /\smuted/);
    assert.match(tag, /\splaysinline/);
    assert.ok(!/crossorigin/.test(tag), "crossorigin is a hard lint error");
  }
});

test("no video is nested inside another timed element", () => {
  // video_nested_in_timed_element is a lint error and a real render bug.
  const html = composeHtml(base);
  // Each <video> must carry its own data-start and not sit inside a
  // <section data-start> wrapper. Assert videos are direct root children.
  const rootBody = html.slice(html.indexOf('data-composition-id="kernelshorts"'));
  assert.ok(!/<section[^>]*data-start[^>]*>\s*<video/.test(rootBody));
});

test("beats are placed back to back in seconds with no gap", () => {
  const html = composeHtml(base);
  assert.match(html, /id="video-hook"[^>]*data-start="0"/);
  assert.match(html, /id="video-body"[^>]*data-start="2\.133333"/);
});

test("the music bed is ducked as linear gain, not decibels", () => {
  const html = composeHtml({ ...base, musicDuckDb: -20 });
  assert.match(html, /id="music"[^>]*data-volume="0\.1"/);
});

test("each beat's own source audio is muted so the VO carries the sound", () => {
  const html = composeHtml(base);
  // No <audio> is emitted for the visual sources at all — the <video> is muted.
  assert.ok(!/id="video-hook-audio"/.test(html));
});

test("a screen recording gets the tuned push-in; stock footage does not", () => {
  const html = composeHtml(base);
  assert.match(html, /id="video-body"[^>]*style="[^"]*scale\(2\.4\)/);
  assert.ok(!/id="video-hook"[^>]*scale\(2\.4\)/.test(html));
});

test("a zoom override replaces the default for that beat", () => {
  const html = composeHtml({ ...base, overrides: { beats: { hook: { zoom: 1.8 } } } });
  assert.match(html, /id="video-hook"[^>]*style="[^"]*scale\(1\.8\)/);
});

test("splitAt cuts a beat into two shots and pushes the second in", () => {
  const html = composeHtml({ ...base, overrides: { beats: { hook: { splitAt: 0.5 } } } });
  assert.match(html, /id="video-hook-a"/);
  assert.match(html, /id="video-hook-b"/);
  // The second shot is pushed in 1.3x relative to the first.
  assert.match(html, /id="video-hook-b"[^>]*style="[^"]*scale\(1\.3\)/);
});

test("a treatment of none drops the title and its scrim together", () => {
  const html = composeHtml({ ...base, overrides: { beats: { hook: { treatment: "none" } } } });
  assert.ok(!/id="title-hook"/.test(html));
  assert.ok(!/id="scrim-hook"/.test(html));
});

test("the scrim is a gradient div, not an imported PNG", () => {
  const html = composeHtml(base);
  assert.ok(!/scrim\.png/.test(html));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/edit/compose.test.ts`
Expected: FAIL — cannot resolve `./compose.js`.

- [ ] **Step 3: Implement `src/edit/compose.ts`**

`composeHtml` assembles, in this DOM order (which **is** the z-order):

1. **Root** `<div id="root" data-composition-id="kernelshorts" data-width data-height data-duration data-fps>`. `data-duration = framesToSeconds(plan.at(-1).endFrame)`.
2. **Per beat, one `<video class="beat-video" id="video-<beatId>">`** — direct root child, carrying its own `data-start`/`data-duration`/`data-media-start`, `muted`, `playsinline`, no `crossorigin`, no timed wrapper. `src` is the staged relative path. The `object-fit: cover` class handles fill; inline `style` carries `transform: scale(<zoom>)` and `object-position`. Defaults from `build-timeline.ts`: screen recordings get `zoom 2.4`, `object-position` from `centerX 0.42` / `centerY 0.32`; everything else `zoom 1` and centered. `overrides.beats[id].zoom` / `.centerY` replace the defaults.
   - `splitAt` between 0.15 and 0.85 on a beat longer than 1.5s emits two videos (`-a`, `-b`) from the same source, the second with `data-media-start` at the cut and `scale(zoom * 1.3)`.
   - `trimStartFrames` / `trimEndFrames` shift `data-media-start` and shorten `data-duration` **without moving the beat boundary** — the boundary is fixed by the VO and must not drift.
   - When the asset is shorter than its beat, the beat's video ends early. Do not stretch; hold the final frame is not available, so instead clamp `data-duration` to the asset length and let the beat's scrim/title cover the remainder. Record this in the module comment as a known difference from Palmier's `speed` stretch, to be evaluated in Task 8's parity check.
3. **Per beat, a scrim** `<div class="clip scrim" id="scrim-<beatId>">` when `needsScrim(index, forced)` and the beat has a title.
4. **Image overlays** from `manifest.overlays`, as `<img class="clip" data-start data-duration>` sized by `overlay.scale` and positioned by `overlay.centerY`.
5. **Titles** via `titleHtml`.
6. **Captions** via `captionsHtml`, per beat, using `alignWords(p.voText, wordTimings.get(p.beatId) ?? [], p.voDurationS)`.
7. **Per beat, one `<audio id="vo-<beatId>" data-volume="1">`** for the voiceover.
8. **One `<audio id="music" data-volume="<dbToGain(musicDuckDb)>">`** spanning the whole composition, when `manifest.music` exists.
9. **One `<script>`** creating `gsap.timeline({ paused: true })`, adding the music fades, and registering it. Music fades from `build-timeline.ts`: 0.5s in, 1.5s out. Because `data-volume` is not 1, the tween targets must be scaled — tween to `dbToGain(musicDuckDb)` at full, not to `1` (lint warns `audio_volume_tween_overrides_gain` when they disagree).

`compose()` additionally: creates `projectDir`, stages every asset into `projectDir/assets/` under beat-keyed names (keep the staging idea from `build-timeline.ts` — it makes the mapping exact — but drop everything about import queues and duration polling, which were Palmier races), writes `index.html`, and returns paths.

Fonts: emit `@font-face` rules pointing at font files staged into `projectDir/assets/fonts/`. If a font named in `text-styles.ts` has no file on disk, **throw** — per PRD §0 there is no fallback to a system font.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec tsx --test src/edit/compose.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edit/compose.ts src/edit/compose.test.ts
git commit -m "Compose a HyperFrames project from a beat plan

DOM order is z-order, so the scrim/title/caption stack needs no track
index bookkeeping, and two text clips can no longer overwrite each other.
Timing is seconds and gain is linear; both conversions go through units.ts.

This is the first time the assembly step has unit tests — it could not be
tested before without a running desktop app."
```

---

## Task 6: The renderer

**Files:**
- Create: `src/edit/render.ts`
- Create: `src/edit/render.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RenderQuality = "draft" | "standard" | "high";
  export interface RenderOptions {
    projectDir: string; outputPath: string;
    quality?: RenderQuality;       // default "high"
    onProgress?: (line: string) => void;
  }
  export function renderArgs(opts: RenderOptions): string[];
  export async function render(opts: RenderOptions): Promise<string>;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/edit/render.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { renderArgs } from "./render.js";

test("the render command pins output, fps and strictness", () => {
  const args = renderArgs({ projectDir: "/tmp/p", outputPath: "/tmp/out.mp4" });
  assert.deepEqual(args.slice(0, 2), ["hyperframes", "render"]);
  assert.ok(args.includes("/tmp/p"));
  assert.ok(args.includes("--output"));
  assert.ok(args.includes("/tmp/out.mp4"));
  // 30fps to match config.video.fps.
  assert.equal(args[args.indexOf("--fps") + 1], "30");
  // A lint error silently disables the layout and contrast audits, so never
  // let a render proceed past one.
  assert.ok(args.includes("--strict"));
});

test("quality defaults to high and is overridable for review iterations", () => {
  const qualityOf = (args: string[]) => args[args.indexOf("--quality") + 1];
  assert.equal(qualityOf(renderArgs({ projectDir: "/p", outputPath: "/o.mp4" })), "high");
  assert.equal(
    qualityOf(renderArgs({ projectDir: "/p", outputPath: "/o.mp4", quality: "draft" })),
    "draft",
  );
});

test("no --resolution flag is passed", () => {
  // --resolution only SUPERSAMPLES by an integer factor; it cannot render
  // smaller. Review iterations use --quality draft instead.
  assert.ok(!renderArgs({ projectDir: "/p", outputPath: "/o.mp4" }).includes("--resolution"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/edit/render.test.ts`
Expected: FAIL — cannot resolve `./render.js`.

- [ ] **Step 3: Implement `src/edit/render.ts`**

```ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../config.js";

/**
 * Renders a composed project to an mp4 via the HyperFrames CLI.
 *
 * Replaces Palmier's export_project + manage_exports polling. There is no job
 * queue to poll and no application to keep alive: the command runs to
 * completion or fails with a real error.
 *
 * On `--strict`: a lint ERROR switches off the layout and contrast audits, so
 * `check` reports "0 samples" and reads like a clean file while nothing ran.
 * Rendering past a lint error would therefore ship an unaudited video.
 *
 * On quality vs resolution: `--resolution` only supersamples upward by an
 * integer factor, so it cannot make a review iteration cheaper. `--quality
 * draft` does, and it changes encoder settings rather than framing — the
 * Layer-2 vision reviewer sees the same composition either way.
 */
export type RenderQuality = "draft" | "standard" | "high";

export interface RenderOptions {
  projectDir: string;
  outputPath: string;
  quality?: RenderQuality;
  onProgress?: (line: string) => void;
}

export function renderArgs(opts: RenderOptions): string[] {
  return [
    "hyperframes", "render", opts.projectDir,
    "--output", opts.outputPath,
    "--fps", String(config.video.fps),
    "--quality", opts.quality ?? "high",
    "--strict",
  ];
}

export async function render(opts: RenderOptions): Promise<string> {
  const [cmd, ...args] = renderArgs(opts);
  await new Promise<void>((resolve, reject) => {
    const child = execFile("npx", [cmd!, ...args], { maxBuffer: 64 * 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()));
    child.stderr?.on("data", (d) => opts.onProgress?.(String(d).trimEnd()));
    child.stdout?.on("data", (d) => opts.onProgress?.(String(d).trimEnd()));
  });
  if (!existsSync(opts.outputPath)) {
    throw new Error(`hyperframes render reported success but ${opts.outputPath} does not exist`);
  }
  return opts.outputPath;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec tsx --test src/edit/render.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edit/render.ts src/edit/render.test.ts
git commit -m "Render a composed project headlessly via the HyperFrames CLI

Replaces export_project plus manage_exports polling. No job queue, no
application to keep alive. --strict because a lint error silently
disables the layout and contrast audits."
```

---

## Task 7: Orchestrate behind a backend flag

**Files:**
- Create: `src/edit/build.ts`
- Modify: `src/config.ts` (add `EDIT_BACKEND`)
- Modify: `src/review/loop.ts:313` (call through the new entry point)
- Modify: `src/run/execute.ts:250-266` (make the Palmier client conditional)
- Modify: `src/m1.ts:174,208` (reads `build.projectPath`, which `BuildResult` no longer has)

**Interfaces:**
- Consumes: everything from Tasks 1-6
- Produces:
  ```ts
  export interface BuildResult {
    plan: BeatPlan[]; totalFrames: number;
    exportPath: string; checkpointPath: string;
    projectDir: string;
  }
  export async function build(opts: BuildOptions): Promise<BuildResult>;
  ```

- [ ] **Step 1: Add the flag to config**

In `src/config.ts`, add to the `Env` schema:

```ts
  /**
   * Which assembly backend runs the edit phase. `palmier` needs the desktop
   * app open; `hyperframes` renders headlessly. Defaults to `palmier` until
   * the parity check in the migration plan passes.
   */
  EDIT_BACKEND: z.enum(["palmier", "hyperframes"]).default("palmier"),
```

- [ ] **Step 2: Write the failing test**

Create `src/edit/build.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { checkpointPathFor } from "./build.js";

test("a checkpoint is a directory copy, not a binary package", () => {
  const p = checkpointPathFor("/runs/x/checkpoints", "run-1", 2);
  assert.ok(!p.endsWith(".palmier"));
  assert.match(p, /run-1-v2$/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/edit/build.test.ts`
Expected: FAIL — cannot resolve `./build.js`.

- [ ] **Step 4: Implement `src/edit/build.ts`**

- `checkpointPathFor(checkpointsDir, runId, iteration)` → `join(checkpointsDir, \`${runId}-v${iteration}\`)`. A HyperFrames project is a directory of text files, so the checkpoint is a recursive copy and is diffable.
- `build(opts)`: `planBeats` → obtain word timings (`npx hyperframes transcribe` per VO file; if it yields no usable word timings, fall through to `alignWords`'s even distribution and **log loudly** that captions are running on estimated timings) → `compose()` → copy the project dir to the checkpoint → `render()` → return `BuildResult`.
- Use `quality: "draft"` when `opts.iteration` is a review iteration and `"high"` for the final master.

- [ ] **Step 5: Wire the flag at the two call sites**

In `src/run/execute.ts` around lines 250-266: only construct/connect/close `PalmierClient` when `config.EDIT_BACKEND === "palmier"`. Pass `client` through as optional.

In `src/review/loop.ts:313`: call `build()` when the backend is `hyperframes`, `buildTimeline()` otherwise. Both return a `BuildResult` whose `exportPath` the loop reads at line 330.

In `src/m1.ts`: line 174 persists `palmier_project_path: build.projectPath` and
line 208 prints it. `BuildResult.projectPath` is gone, replaced by `projectDir`.
Change both to read `build.projectDir`, keeping the persisted key
`palmier_project_path` for now — the key itself is renamed in Task 11, and doing
it here would mean touching `src/shared/schemas.ts` twice. Run `pnpm typecheck`
to confirm nothing else reads the removed field.

- [ ] **Step 6: Run everything**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. With `EDIT_BACKEND` unset the pipeline behaves exactly as before.

- [ ] **Step 7: Commit**

```bash
git add src/edit/build.ts src/edit/build.test.ts src/config.ts src/review/loop.ts src/run/execute.ts
git commit -m "Wire the HyperFrames backend behind EDIT_BACKEND

Defaults to palmier so main stays shippable. Checkpoints become directory
copies rather than binary .palmier packages, so an iteration diff is
readable."
```

---

# PHASE 3 — Parity

## Task 8: Compare both backends on a real past run

**Files:**
- Create: `scripts/parity.ts`

- [ ] **Step 1: Write the harness**

`scripts/parity.ts` takes a run id, loads its `script.json` and asset manifest from the run workspace, and builds the same `BeatPlan` through both backends into two mp4s.

- [ ] **Step 2: Run it against a real completed run**

Run: `pnpm exec tsx scripts/parity.ts <run-id>`

- [ ] **Step 3: Compare and record**

For both outputs, record: ffprobe duration / resolution / fps, LUFS before normalization, and a frame grab at the midpoint of every beat. Check, beat by beat: framing and zoom, title treatment and position, caption position and active-word timing, scrim presence, and the music/VO balance.

Write the findings to `docs/superpowers/specs/2026-09-04-hyperframes-parity.md`, including **render wall-clock for both backends** — this is the risk the design flagged. Note explicitly whether the short-asset case (Palmier stretched with `speed`; HyperFrames ends the clip early) is visible.

- [ ] **Step 4: Fix any divergence, then commit**

```bash
git add scripts/parity.ts docs/superpowers/specs/2026-09-04-hyperframes-parity.md
git commit -m "Parity check: HyperFrames vs Palmier on a real run"
```

---

# PHASE 4 — Port the verifiers and flip the default

## Task 9: `timeline_gaps` moves to the plan

**Files:**
- Create: `src/verify/plan-gaps.ts`, `src/verify/plan-gaps.test.ts`
- Modify: `src/verify/timeline.ts` (`checkTimelineGaps` delegates when the backend is hyperframes)

**Interfaces:**
- Produces: `export function findPlanGaps(plan: BeatPlan[]): TimelineGap[]`

Keep the verifier's **name** `timeline_gaps` so persisted rubric records stay comparable across the migration.

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { findPlanGaps } from "./plan-gaps.js";
import type { BeatPlan } from "../edit/plan-beats.js";

const beat = (id: string, s: number, e: number) =>
  ({ beatId: id, startFrame: s, endFrame: e } as BeatPlan);

test("a contiguous plan has no gaps", () => {
  assert.deepEqual(findPlanGaps([beat("a", 0, 60), beat("b", 60, 120)]), []);
});

test("a hole between beats is reported with its frame range", () => {
  const gaps = findPlanGaps([beat("a", 0, 60), beat("b", 64, 120)]);
  assert.equal(gaps.length, 1);
  assert.deepEqual([gaps[0]!.startFrame, gaps[0]!.endFrame], [60, 64]);
});

test("a plan that does not start at frame zero is a gap", () => {
  assert.equal(findPlanGaps([beat("a", 3, 60)]).length, 1);
});

test("overlapping beats are reported too — they mean drifted boundaries", () => {
  assert.equal(findPlanGaps([beat("a", 0, 60), beat("b", 50, 120)]).length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/verify/plan-gaps.test.ts`
Expected: FAIL — cannot resolve `./plan-gaps.js`.

- [ ] **Step 3: Implement `src/verify/plan-gaps.ts`**

Walk the plan in order against a cursor starting at frame 0. Emit a
`TimelineGap` (reuse the interface from `src/verify/timeline.ts:91`) whenever
`beat.startFrame !== cursor` — greater means a hole that would render black,
less means beats overlap, which means a boundary drifted off the VO. Set the
cursor to `beat.endFrame` and continue.

- [ ] **Step 4: Delegate from the existing verifier**

In `src/verify/timeline.ts`, `checkTimelineGaps` keeps its name and its
`VerifierResult` shape so persisted rubric records stay comparable. When the
backend is `hyperframes` it calls `findPlanGaps(plan)` instead of reading a
Palmier timeline.

- [ ] **Step 5: Run the tests and commit**

Run: `pnpm test && pnpm typecheck`

```bash
git add src/verify/plan-gaps.ts src/verify/plan-gaps.test.ts src/verify/timeline.ts
git commit -m "Check for gaps on the beat plan rather than a rendered timeline

Under composition-from-planBeats a gap is a planning error, not a render
artifact, so check the plan directly. Overlaps are reported too: they mean
a beat boundary drifted off the voiceover that defines it."
```

## Task 10: Measured caption safe area, and flip the default

**Files:**
- Modify: `src/verify/timeline.ts` (`checkCaptionSafeArea`)

`SAFE_AREA` stays `{ topClear: 0.1, bottomClear: 0.25 }`. Replace the font-size estimate with a real measurement: load the composed `index.html` in Playwright (already a dependency), seek to each caption's midpoint, and read `getBoundingClientRect()` on the caption and title nodes.

- [ ] Implement, test against the parity run's project, and confirm it reproduces the known-good result.
- [ ] Change the `EDIT_BACKEND` default in `src/config.ts` from `"palmier"` to `"hyperframes"`.
- [ ] Run a full pipeline end to end with **Palmier not running** and confirm it completes. This is the acceptance test for the entire migration.
- [ ] Commit.

---

# PHASE 5 — Delete Palmier

## Task 11: Remove the old backend

Only after Task 10's headless run succeeds.

- [ ] **Step 1: Delete the files**

```bash
git rm src/palmier/client.ts src/palmier/client.test.ts \
       src/edit/build-timeline.ts src/edit/text-styles.ts \
       src/edit/correct-captions.ts src/edit/scrim.ts
```

- [ ] **Step 2: Remove the flag**

Delete `EDIT_BACKEND` from `src/config.ts` and both branches at its call sites in `src/review/loop.ts` and `src/run/execute.ts`.

- [ ] **Step 3: Rename the persisted field**

In `src/shared/schemas.ts:339`, rename `palmier_project_path` to `project_dir`. Update `src/m1.ts:174` and anything reading it. Existing run-state documents carry the old key; since it is `.optional()`, old runs simply have neither field — acceptable, as run state is per-run and not migrated.

- [ ] **Step 4: Sweep for stragglers**

```bash
grep -rni "palmier" src/ web/src/ *.md
```

Update `prd.md` and any docs that describe the edit phase as Palmier-driven. The `contentTypeFor` test in `src/run/artifacts.test.ts` asserts on `"checkpoint.palmier"` — change that fixture to a `.mp4` or a directory name.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm typecheck`

```bash
git commit -am "Remove Palmier Pro

The pipeline now renders headlessly. Deleted with it: the reverse-
engineered MCP client, the staged-directory import that worked around a
wedging import queue, the canvas re-assertion that worked around landscape
media resetting the project, the duration polling that worked around
'ready' arriving before durations, the project-close bookkeeping that
worked around leaked projects degrading the app, and the caption rewrite
that worked around ASR guessing at words we already knew."
```

---

## Notes for the executor

- **Do not run `npx hyperframes render` until `npx hyperframes lint` is clean.** A lint error disables the layout and contrast audits, and `check` then reports zero findings for the wrong reason.
- **`npx hyperframes preview --background`** is the review surface if you need to see what a composition looks like mid-task; stop it with `npx hyperframes preview --stop`.
- The HyperFrames CLI is **not installed** on this machine yet. `npx hyperframes` fetches it on first use. Task 6 is where that first happens.
- If a task's tests pass but you are unsure the render is right, take a `npx hyperframes snapshot --at <t>` frame and look at it. The layout audit measures bounding boxes, not pixels, so it cannot catch everything.
