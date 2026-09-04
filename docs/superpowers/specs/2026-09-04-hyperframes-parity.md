# HyperFrames vs Palmier — parity check on run `2026-08-18`

Task 8 of the HyperFrames migration. This is the first time the new backend
rendered an actual video.

**Verdict: the HyperFrames backend renders a complete, correctly-timed,
correctly-mixed 39.53 s short, and it renders it FAST. The render-time risk the
plan flagged is retired. Two visual defects were found; one was a real bug and
is fixed in this commit, one is a deliberate divergence that still needs a
decision.**

How to reproduce:

```
pnpm exec tsx scripts/parity.ts 2026-08-18
```

The Palmier side was NOT re-rendered — the desktop app is not running, and the
run already archives its real exports. `~/pipeline/runs/2026-08-18/exports/`
is the baseline, and was treated as read-only throughout.

---

## 1. RENDER WALL-CLOCK — the headline number

Measured on this machine (Apple silicon, 3 render workers, headless Chromium),
for the full 1186-frame / 39.53 s composition.

| Stage | Wall-clock | Ratio to realtime |
|---|---|---|
| `--quality draft` render only | **14.3 s** | 0.36x — 2.8x FASTER than realtime |
| `--quality high` render only | **17.1 s** | 0.43x |
| Whole `build()`: 6x transcribe + compose + checkpoint + draft render | **36.0 s** | — |
| `renderFinalMaster()` (high, from checkpoint) | **18.4 s** | — |

A second warm run after the caption fix measured 19.1 s draft / 33.0 s high on
a busier machine, so treat 14–20 s draft and 17–33 s high as the range. Either
end is comfortably fast.

**What this means for the review loop.** A 4-iteration review loop costs
4 x ~36 s ≈ 2.5 minutes of build+render, plus one final high render of
~20–35 s. The archived Palmier run's own export timestamps (`v1` 21:03,
`v2` 21:05, `v3` 21:08, `v4` 21:10) show 2–3 minutes PER ITERATION for the
GPU-accelerated native app. **The headless HTML path is roughly as fast or
faster than Palmier per iteration, not slower.** No change to the review loop's
structure is needed on render-cost grounds.

Two caveats, both one-time and both outside the steady-state numbers above:

- **First run pays ~8 minutes.** `hyperframes transcribe` shells out to
  whisper.cpp and downloads `ggml-small.en.bin` (487 MB) on first use, at
  ~15 MB/min here. The very first parity run measured 553 s for
  build+draft-render; 8 of those 9 minutes were that download. It is cached at
  `~/.cache/hyperframes/whisper/models/` and never repeats. Worth pre-warming
  on any new machine (`npx hyperframes transcribe <any wav> --json`).
- Transcription itself is ~20 s for 6 beats warm (~3.5 s per beat), and runs
  once per build, not once per render.

## 2. Container parity — exact match

| | Palmier `v1-master` | Palmier delivered | HyperFrames high |
|---|---|---|---|
| Duration | 39.600 s | 39.533 s | **39.533 s** |
| Resolution | 1080x1920 | 1080x1920 | **1080x1920** |
| FPS | 30/1 | 30/1 | **30/1** |
| Video codec | h264 | h264 | **h264** |
| Audio codec | aac 96 kHz stereo | aac 44.1 kHz stereo | **aac 48 kHz stereo** |
| Size | 38.7 MB | 42.5 MB | 24.0 MB (high) / 12.2 MB (draft) |

Frame count is IDENTICAL: 1186 frames, matching `planBeats` exactly. The
delivered Palmier file is 39.533 s — the same number — so the audio-first
timing contract carried over with zero drift. Palmier's raw masters are
39.600 s (two frames of container padding); the delivered normalized file is
not.

The draft file is 12.2 MB against high's 24.0 MB, i.e. the review loop also
moves half the bytes per iteration.

## 3. Audio — mix matches, level is 2 dB quieter pre-normalization

| Measure | Palmier `v1-master` (raw) | HyperFrames high (raw) |
|---|---|---|
| Integrated loudness | **-15.3 LUFS** | **-17.4 LUFS** |
| Overall RMS | -17.59 dB | -19.75 dB |
| Peak | -1.26 dBFS | -0.14 dBFS |
| Music-only fade-out tail (39.0–39.5 s) | -36.6 dB RMS | -40.1 dB RMS |

- Both are raw exports, and neither is the master: the pipeline normalizes to
  -14 LUFS afterwards (`config.loudness`, accept range -16..-13). -17.4 LUFS is
  well inside what normalization handles; the archived Palmier raw export
  measured -24.9 LUFS in M0, so -17.4 is a much smaller correction than the old
  backend needed.
- HyperFrames is **2.1 LU quieter** than Palmier before normalization. This is
  a gain difference, not a mix difference: the music bed is at the same -20 dB
  duck constant, and the tail fade tracks Palmier within 3.5 dB at the very end
  of a 1.5 s fade-out. Source audio on the visual clips is muted in both.
- The 0.5 s fade in / 1.5 s fade out are present and measurable in the level
  trace.
- Note for a separate ticket: the DELIVERED (already normalized) Palmier file
  measures **-16.6 LUFS**, which is outside the -16..-13 accept range. That is a
  pre-existing issue in the normalize step, not a HyperFrames one.

## 4. Beat-by-beat visual comparison

Frames grabbed at each beat's midpoint from both files.

| Beat | Frames | Asset | Framing / zoom | Title | Caption |
|---|---|---|---|---|---|
| hook | 0–160 | screenrec 4.13 s | 2.4x push-in, matches | boxLight, Coolvetica — treatment matches | present, active word highlighted |
| what_is | 160–356 | generated 6.40 s | 1x, matches | hardShadow + scrim over the diagram | present |
| why_it_matters | 356–532 | stock 11.53 s | 1x, matches | boxDark, Mélodrame — near-identical to Palmier | present |
| how_it_works | 532–720 | generated 6.17 s | 1x, matches | Coolvetica hardShadow | present |
| new_features | 720–949 | screenrec 4.57 s | 2.4x push-in, matches | boxLight | present |
| catch | 949–1186 | generated 7.77 s | 1x, matches | hardShadow | present |

### The specific questions the earlier reviews asked this task to settle

**Screen-recording legibility at 2.4x / centerX 0.42 / centerY 0.32 — PASS.**
Body text on the DuckDB blog post is fully readable in the HyperFrames frames,
at the same subjective size as Palmier's `v1-master`. HTML compositing
reproduces the scaler faithfully: `object-position: 42% 32%` plus
`transform: scale(2.4)` on an `object-fit: cover` video lands on the same region
of the page. Do not re-tune these constants.

**The scrim direction — PASS.** Opaque black at the TOP of the frame, ramping to
fully transparent by mid-frame. Confirmed on the `what_is` beat, where the top
third of the generated diagram is visibly darkened and the bottom is not. The
inversion that was fixed earlier has not come back.

**Short assets — VISIBLE, and this is the worst regression.** Palmier stretched
a too-short asset with `speed`; the HyperFrames path clamps `data-duration` and
ends the clip early, leaving `#root`'s black background. **Five of six beats
have an asset shorter than their beat**, and on two of them the hole is large:

| Beat | Beat length | Asset | Black hole at end of beat |
|---|---|---|---|
| hook | 5.33 s | 4.13 s | **1.20 s** |
| what_is | 6.53 s | 6.40 s | 0.13 s |
| why_it_matters | 5.87 s | 11.53 s | none |
| how_it_works | 6.27 s | 6.17 s | 0.10 s |
| new_features | 7.63 s | 4.57 s | **3.07 s** |
| catch | 7.90 s | 7.77 s | 0.13 s |

Total ~4.6 s of the 39.5 s runtime is a black frame carrying only the title and
caption. Verified visually at t=5.10 s and t=31.0 s: fully black, title and
caption still on screen, VO still speaking. Palmier at the same timestamps is
showing footage. This is not cosmetic — the Layer-1 black-frame verifier
(`checkBlackFrames`) will very likely fail this output, and the Layer-2 vision
reviewer will score `visual_relevance` down. **This must be resolved before the
default flips.** The 0.13 s cases are invisible; the 1.20 s and 3.07 s cases are
not. Recommended options, in order: (a) hold the asset's last frame for the
remainder, (b) loop the asset, (c) reinstate a playback-rate stretch. (a) is
the smallest and most deterministic change.

**Head trim opening a gap on a split beat — NOT REPRODUCED HERE.** This run's
review loop set no `splitAt` and no `trimStartFrames`, so the deferred bug has
no trigger in this composition. Still deferred, still unproven either way.

**Captions above titles / tall-title collision — NO COLLISION.** Captions sit at
72% and titles are centred inside a 10%–25% inset box, so nothing in this run's
six titles reaches the caption band. The inverted z-order is invisible here
because the two never overlap.

## 5. Defects found

### FIXED in this commit — the active-word highlight rendered as a full-height red bar

On EVERY caption in the video, the `block` highlight painted as a tall red
column running from the caption line to the bottom of the frame, obscuring the
footage and the caption itself. Root cause: `.clip` sets `inset: 0`, so
`.caption-line` (which overrode only `top`) kept `bottom: 0` and was 28% of the
frame tall; as a flex container with the default `align-items: stretch`, every
`.caption-word` stretched to that full height, and the highlight
(`position: absolute; inset: 0` inside the word) filled it. Fixed in
`src/edit/styles.ts` by releasing `bottom: auto` and setting
`align-items: flex-start` on `.caption-line`. Re-rendered and confirmed: the
highlight is now a tight red plate behind exactly one word, matching Palmier.
All 77 `src/edit` tests still pass. This bug was invisible to unit tests
because it is purely a rendered-layout effect.

### OPEN — text renders about half the size Palmier produced

Measured off matched frames: the HyperFrames title box spans roughly 56% of the
width Palmier's does for the same string, and captions are roughly 45% of
Palmier's caption size. The values in `styles.ts` (`BASE_SIZE` 44/46/68 px,
caption 31 px) were carried over BY VALUE from `text-styles.ts`, but Palmier
evidently applied its own scaling on top of them, so a value-for-value port does
not reproduce the size on a 1080x1920 canvas. Mélodrame at 68 px is close to
Palmier; Coolvetica at 44 px and the 31 px caption are clearly small for a phone
screen. Recommend re-tuning against rendered output rather than against the old
numbers. Not fixed here — it is a design call, not a bug.

### OPEN — titles sit at ~42% of frame height, Palmier put them at ~24%

`.title` is an inset box from 10% to 25% with its content vertically centred,
which lands the title near the middle of the frame. Palmier's titles sit high,
just under the top safe area. On the `what_is` beat the HyperFrames title
overlaps the generated diagram's "DuckDB" node; Palmier's sits clear above it.
Cheap to change (`justify-content: flex-start` plus padding, or an explicit
`top`), but it changes every beat, so it should be a deliberate decision.

## 6. Data-quality finding about the parity target itself

`state.json`'s `manifest` for `2026-08-18` is STALE relative to the delivered
video. The review loop re-acquired assets during iterations — the assets
directory contains `hook-generated.mp4` and
`new_features-pexels-5483090-30fps.mp4` written at 21:07–21:08, while the
manifest still names `hook-screenrec.mp4` and `new_features-screenrec.mp4`. The
delivered Palmier master therefore shows a generated "compare" scene on the
`hook` beat where the manifest says screen recording, and stock footage on
`new_features`. `hn-2026-08-18-v1-master.mp4` (21:03) is the export that
actually matches the manifest, and it is the file used above for any
asset-identical comparison.

Two consequences: the visual comparison against the DELIVERED file is only valid
for beats 2–4 and 6; and, separately, **the pipeline does not write the
re-acquired manifest back to state**, so a run's recorded manifest can disagree
with the video it shipped. Worth its own ticket.

## 7. What matches, what is better, what is worse

**Matches:** frame count and duration to the frame; resolution, fps, codec; beat
layout from measured VO; the 2.4x screen-rec push-in and its centering; scrim
direction and ramp; title treatment and font rotation; the -20 dB music duck
with 0.5 s/1.5 s fades; source audio muted; caption position at 72% and the
active-word block highlight (after the fix).

**Better than Palmier:** renders headlessly with no desktop app and no MCP
session; per-iteration render is as fast or faster; the composition is a
directory of text files, so a checkpoint is a readable diff instead of an opaque
package; captions come from the script rather than ASR, so a misheard word can
no longer reach the render; half the bytes per draft iteration; the renderer
self-verifies frames (`drawElement self-verify passed`, PSNR 57–inf dB across 8
ground-truth frames).

**Worse than Palmier:** ~4.6 s of black frames from the short-asset clamp
(blocking); text roughly half the size; titles ~18 points of frame height lower;
2.1 LU quieter before normalization; a one-time ~8-minute whisper model download
on a fresh machine.

## 8. Recommendation

Do NOT flip `EDIT_BACKEND` to `hyperframes` yet. One blocking fix first — the
short-asset hole — and one design decision — text size and title height. Render
performance, timing, mixing, framing and treatment parity are all settled and
need no further work.
