# HyperFrames vs Palmier — parity check on run `2026-08-18`

Task 8 of the HyperFrames migration. This is the first time the new backend
rendered an actual video.

**Verdict: the HyperFrames backend renders a complete, correctly-timed,
correctly-mixed 39.53 s short, it renders it FAST, and it now reproduces
Palmier's rendered output to within a fraction of a percent. The render-time
risk the plan flagged is retired. Four visual defects were found; ALL FOUR ARE
FIXED.**

Revision 2 (post-fix). The first pass of this document listed three open
items — black frames from the short-asset clamp, text at ~half Palmier's size,
and titles ~18 points of frame height too low. All three have been fixed and
re-measured, plus a fourth (caption vertical anchor) that only became visible
once the type was calibrated. The render-timing section is unchanged in
substance: the fixes cost ~1 s of build time for still extraction and did not
move the render numbers.

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

These numbers PREDATE the fixes below but did not materially change: the final
post-fix run measured **14.6 s draft / 19.5 s high**, with `build()` at 36.5 s.
The only added cost is one ffmpeg still per held interval (7 stills, ~1 s
total).

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

**Short assets — WAS the worst regression, now FIXED.** Palmier stretched a
too-short asset with `speed`; this backend clamps `data-duration` and used to
leave `#root`'s black background showing for the remainder. **Five of six beats
have an asset shorter than their beat**, and on two of them the hole was large:

| Beat | Beat length | Asset | Black hole (before) | After |
|---|---|---|---|---|
| hook | 5.33 s | 4.13 s | **1.20 s** | held still |
| what_is | 6.53 s | 6.40 s | 0.13 s | held still |
| why_it_matters | 5.87 s | 11.53 s | none | none |
| how_it_works | 6.27 s | 6.17 s | 0.10 s | held still |
| new_features | 7.63 s | 4.57 s | **3.07 s** | held still |
| catch | 7.90 s | 7.77 s | 0.13 s | held still |

~4.6 s of the 39.5 s runtime was a black frame carrying only the title and
caption while the VO kept talking. `compose.ts` now covers every uncovered
interval of a beat with a held still of the last frame shown, extracted with
ffmpeg at compose time and placed as a timed `<img>` — the freeze/hold recipe
from the HyperFrames docs, which explicitly supports a final-source-frame hold.
The held still inherits the shot's zoom and `object-position`, so the picture
stops rather than jumps.

Verified: `ffmpeg blackdetect=d=0.05:pix_th=0.10` over the whole finished video
reports **zero** black intervals (it previously flagged the two large holes),
and frame grabs at t=5.10 s and t=31.0 s — formerly pure black — now show the
held page with the title and caption over it.

`data-playback-rate` (a documented constant retime, normalized 0.1..5) was also
available and would have reproduced Palmier's stretch more literally. A hold
was chosen because it is frame-exact, cannot drift, and these particular assets
are static or slow-scrolling, where a hold is close to invisible. If a future
beat uses genuinely moving footage that falls short, the retime is the better
tool and is a one-line change.

**Head trim opening a gap on a split beat — NOT REPRODUCED HERE, AND NOW
STRUCTURALLY CLOSED.** This run's review loop set no `splitAt` and no
`trimStartFrames`, so the deferred bug had no trigger in this composition. It
is now moot regardless: the hold above is computed from the SHOT LIST rather
than from the asset length, so a mid-beat gap is an uncovered interval like any
other and gets filled. Covered by a unit test that sets `splitAt` and
`trimStartFrames` together.

**Captions above titles / tall-title collision — NO COLLISION,** before or
after the repositioning. Captions are centred at 72% and titles at 24%; the
tallest possible title (three lines of Mélodrame at 122 px) spans roughly
15.5%–32.5%, nowhere near the caption band. The inverted z-order is invisible
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

### FIXED — text rendered about half the size Palmier produced

Titles measured ~56% and captions ~45% of Palmier's rendered size. `styles.ts`
carried `BASE_SIZE` 44/46/68 px and caption 31 px over BY VALUE from
`text-styles.ts`, whose comment calls them "px at 1080x1920". That comment is
wrong: Palmier evidently treated them as coordinates in a smaller reference
space and scaled up on export.

Calibrated empirically against matched frames of `v1-master`, measuring glyph
bounding boxes for the identical string in the identical face:

| Beat / face | Palmier | HyperFrames (before) | Factor |
|---|---|---|---|
| why_it_matters, Mélodrame, "Analyze 150GB locally" | 804x107 px | 449x58 px | 1.790 w / 1.845 h |
| hook, Coolvetica, "40x faster queries" | 584x72 px | 326x40 px | 1.791 w / 1.800 h |
| caption line, "since the release of v1.5" | 541 px wide | 321 px wide | 1.806 |

Two different faces and the caption agreeing to within 1% is why this is a
single `PALMIER_SCALE = 1.8` rather than a per-element fudge — and 1080/600 =
1.8 exactly, so a 600-wide reference space explains it. I had expected titles
and captions to need different factors from the first pass's rough 56%/45%
figures; measuring properly showed they do not. The 45% was an artefact of
measuring the caption's bbox HEIGHT, which is dominated by the red plate's
padding, instead of the line's width.

Applied to sizes (44/46/68 -> 79/83/122), line spacing (-14/2/-18 ->
-25/4/-32), title box padding and radius, the hard-shadow offset, and the
caption stroke (3 -> 5 px). The 12 px inter-word `gap` is OURS, not Palmier's,
and deliberately does NOT scale — at 12 px the predicted line width is 539 px
against Palmier's measured 541 px, while scaling it overshoots to 579 px.

Result after the fix, same frame, same measurement:

| | Palmier | HyperFrames (after) | Delta |
|---|---|---|---|
| Title glyph box | 804x107 px | **807x106 px** | +0.4% w, -0.9% h |
| Caption line width | 541 px | **542 px** | +0.2% |

`PALMIER_SCALE` and the measurements behind it are recorded in `styles.ts` with
an explicit "DO NOT tidy these back to round numbers" note, so the next reader
does not restore Palmier's raw values and halve the type again.

### FIXED — titles sat at ~42% of frame height, Palmier put them at ~24%

`.title` was an inset box (top 10% / bottom 25%) with its content flex-centred,
landing the title's centre at ~42%. Measured Palmier glyph-box centres in
`v1-master`: **0.2370** (why_it_matters) and **0.2456** (hook). The title now
anchors its CENTRE at `TITLE_CENTER_Y = 0.24` via `top: 24%` +
`translateY(-50%)`, which holds that position at any line count.

Measured after the fix: title glyph centre at **0.2372** of frame height
against Palmier's 0.2370. The `what_is` overlap with the diagram's middle node
is gone — the title now sits clear above the "Application" box, as Palmier's
did. Clearance is `SAFE_AREA.topClear` (0.1) safe at the largest title size.

### FIXED — caption vertical anchor (found only after calibrating the type)

`.caption-line` used `top: 72%`, but Palmier's `captionArgs()` `transform.y` of
0.72 was a CENTRE — which is also what `BuildOverrides.captionCenterY` is named
for. At 31 px the difference was small enough to miss; at the calibrated 56 px
the taller line pushed the caption's measured centre to 0.7367 against
Palmier's 0.7195. Adding `translateY(-50%)` makes the declared number mean what
it says at any font size.

Measured after the fix: caption line centre at **0.7195** of frame height —
matching Palmier to four decimal places.

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

**Matches:** frame count and duration to the frame; resolution, fps, codec;
beat layout from measured VO; the 2.4x screen-rec push-in and its centering;
scrim direction and ramp; title treatment and font rotation; the -20 dB music
duck with 0.5 s/1.5 s fades; source audio muted; the active-word block
highlight; **title size to within 1% and title height to within 0.0002 of frame
height; caption width to within 0.2% and caption height to four decimal
places**; and no black frames anywhere.

**Better than Palmier:** renders headlessly with no desktop app and no MCP
session; per-iteration render is as fast or faster; the composition is a
directory of text files, so a checkpoint is a readable diff instead of an opaque
package; captions come from the script rather than ASR, so a misheard word can
no longer reach the render; half the bytes per draft iteration; the renderer
self-verifies frames (`drawElement self-verify passed`, PSNR 57–inf dB across 8
ground-truth frames).

**Worse than Palmier:** 2.1 LU quieter before normalization (well within what
the normalize step corrects, and a much smaller correction than Palmier's own
-24.9 LUFS raw export needed); a one-time ~8-minute whisper model download on a
fresh machine; and a short asset now HOLDS its last frame where Palmier slowed
the clip, which is a real if minor difference on genuinely moving footage.

## 8. Recommendation

The blocking item is cleared and the two design divergences are closed against
measurements. Timing, mixing, framing, treatment and now text parity are all
settled. The remaining prerequisites for flipping `EDIT_BACKEND` are the ported
verifiers in Phase 4, not anything found here.

One thing to watch on the next run that exercises it: a beat whose asset falls
short and whose footage genuinely MOVES will now visibly freeze rather than
slow down. `data-playback-rate` is the documented alternative if that ever
reads badly.
