# Migrating video assembly from Palmier Pro to HyperFrames

Status: approved design, not yet implemented
Date: 2026-09-04

## Why

kernelshorts assembles every short by driving Palmier Pro, a desktop NLE, over a
local MCP server on `127.0.0.1:19789`. The pipeline therefore cannot run unless
that application is open on this machine. A daily worker that requires a GUI to
be running is not a pipeline.

HyperFrames renders video from HTML. It ships `@hyperframes/sdk` for headless,
framework-neutral composition editing from Node and `@hyperframes/producer` for
rendering from Node, so assembly becomes a library call rather than remote
control of a stateful application.

A second, larger reason emerged from reading `src/edit/build-timeline.ts`:
roughly half of it is Palmier damage control, documented in its own comments.

- The media import queue wedges permanently on the ninth single-file import,
  worked around by staging every file into one directory and importing once.
- Placing landscape media silently re-sets the canvas (1080x1920 became
  1280x720 with only an advisory note), worked around by re-asserting and
  verifying the canvas after `add_clips`.
- Directory import reports `status: "ready"` before durations exist, worked
  around by `waitForDurations` polling, because every beat boundary is computed
  from those numbers.
- Leaked open projects degrade the app until `import_media` hangs on every
  file, worked around by closing the project on every path.
- Track indices go stale after each mutating call, worked around by re-reading
  the timeline repeatedly.
- Two text clips sharing a frame range on one track silently overwrite each
  other, worked around by one `add_texts` call per layer.
- Captions cannot stroke ordinary words while leaving the highlighted word
  unstroked, worked around with two stacked caption layers.
- `manage_project close` saves rather than removes the package, so reruns
  collide, worked around by `removeStaleProject`.

None of these failure modes exist in an HTML composition. Z-order is DOM order,
the canvas is whatever the document says it is, and there is no media library
to race against.

## Decisions taken before this document

- **Render target: local headless.** `@hyperframes/producer` renders on the
  same machine that runs the pipeline. No desktop app, no new cloud account,
  no new credentials. HeyGen managed cloud, AWS Lambda, and Google Cloud Run
  remain available later; the render call is a seam, so switching is a config
  change. Note the existing AWS IAM user (`kernelshorts-bedrock`) can only
  invoke Bedrock, so any cloud render target would need new credentials.
- **Approach: rewrite the edit layer as a composition builder, sequenced as a
  strangler.** Rejected: hiding HyperFrames behind an `EditBackend` port shaped
  by Palmier's imperative vocabulary (`clipIds`, `trackIndex`,
  `setClipProperties`, re-read-after-every-call). That would port the
  workarounds instead of deleting them.
- **No spike first.** Open questions are resolved during implementation.

## Architecture

The pipeline spine is unchanged:

```
script + manifest -> planBeats -> [ASSEMBLE] -> .mp4 -> normalize -> verify L1 -> review L2 -> deliver
```

Only `[ASSEMBLE]` is replaced.

```
planBeats(script, manifest)   -> BeatPlan[]     (unchanged, pure)
compose(plan, overrides)      -> project dir    (index.html + assets)
render(projectDir, opts)      -> master.mp4     (@hyperframes/producer)
```

### Modules

| Module | Role | Replaces |
| --- | --- | --- |
| `src/edit/plan-beats.ts` | `planBeats`, extracted verbatim | moved out of `build-timeline.ts` |
| `src/edit/compose.ts` | `BeatPlan[]` + overrides -> composition HTML | the imperative middle of `build-timeline.ts` |
| `src/edit/styles.ts` | variant cycle, treatments, `splitLines` -> CSS/DOM | `text-styles.ts` |
| `src/edit/captions.ts` | word timings -> active-word caption DOM | `add_captions` + `correct-captions.ts` |
| `src/edit/render.ts` | headless render to mp4 | `exportAndWait` + `manage_exports` |
| `src/edit/build.ts` | orchestrates the above, returns `BuildResult` | `build-timeline.ts` |

### Deleted at the end of the migration

`src/palmier/client.ts`, `src/palmier/client.test.ts` (1,137 lines together),
`src/edit/correct-captions.ts`, `src/edit/scrim.ts`, and inside the old
`build-timeline.ts`: `waitForDurations`, `removeStaleProject`, `fillTransform`,
the staging-directory import, the canvas hijack assertion, and every
re-read-because-indices-moved call.

### BuildResult

`BuildResult` keeps `plan`, `totalFrames`, `exportPath`, and `checkpointPath`.
`timelineId` and `projectPath` are removed; `projectDir` (the composition
directory) replaces them. `review/loop.ts` reads only `build.exportPath`, so this is a
narrow change. `src/m1.ts` also reads `projectPath` and `checkpointPath`, and
persists the former as the run-state field `palmier_project_path`
(`src/shared/schemas.ts:339`); that field is renamed to `project_dir` in
phase 5, when the flag and the Palmier path are removed together.

## The four translations that carry the most weight

**Fill becomes CSS.** `fillTransform` exists only because Palmier auto-fits
media to *contain*, so the code computed a reciprocal scale to fill a 9:16
frame (measured: 1280x720 into 1080x1920 needs width 3.165). In HTML this is
`object-fit: cover` and the function is deleted. The `zoom` override becomes
`transform: scale()`; `centerX`/`centerY` become `object-position`. The
screen-recording defaults (`zoom` 2.4, `centerX` 0.42, `centerY` 0.32) carry
over as the same numbers expressed in CSS.

**Scrim becomes a gradient.** `ensureScrim` generates a PNG and imports it as
media so it can sit above footage and below text. It becomes a `<div>` with a
`linear-gradient`, rendered per beat by the existing
`needsScrim(index, treatment)` predicate, positioned by DOM order.

**Text layers become DOM order.** The two-track caption hack and the
overwriting-text-clips bug both disappear. Stroked ordinary words and an
unstroked highlighted word are nested spans with different classes.

**Captions become forced alignment rather than transcription.** Today Palmier
transcribes the voiceover and `correct-captions.ts` rewrites the result against
the script, because the transcriber guessed at words already known. The script
produced the audio, so only per-word *timings* are needed. Two candidates, to
be chosen during implementation:

1. `hyperframes transcribe` from the CLI.
2. Soniox, already wired: `SONIOX_API_KEY` is in config and `transcribeFile()`
   already exists in `src/verify/timeline.ts`.

Selection criterion: word-level timings accurate enough to drive the
active-word highlight on a per-beat voiceover clip. Words always come from
`beat.vo_text`, never from the transcriber. If neither yields usable word
timings, the fallback is proportional distribution of the beat's words across
its measured voiceover duration, which is visibly worse and must be reported
rather than shipped silently.

## What deliberately does not change

`BuildOverrides` stays verbatim: `captionCenterY`, `captionFontSize`, and per
beat `trimStartFrames`, `trimEndFrames`, `zoom`, `centerY`, `treatment`,
`splitAt`. This is the closed vocabulary `src/review/directives.ts` speaks, so
the reviewer, the rubric, and the directive mapping need no changes. `splitAt`
becomes two DOM clips instead of two timeline clips; the second still pushes in
by 1.3x so the cut reads as a change of framing. Everything else maps to CSS.

`review/loop.ts` loses only the `client` parameter and the `keepOpen`/close
bookkeeping. `run/execute.ts` loses `new PalmierClient(...)`, `connect()`, and
`close()`.

`checkScriptFidelity`, `wordSimilarity`, `transcribeFile`, and all of
`src/verify/media.ts` are backend-agnostic and are untouched.

This freezes the new backend into vocabulary invented for an NLE. That is an
accepted cost: it keeps the entire review subsystem out of this migration's
blast radius. Widening the vocabulary to exploit HTML (per-word animation,
easing, transitions) is deliberately deferred to later work.

## Verifiers that change

**`timeline_gaps`** currently reads Palmier's track structure to answer "will
the render show black?". Under composition-from-`planBeats`, gaps are
structurally impossible, so the check moves up to assert contiguity and
non-overlap on `BeatPlan[]` directly: cheaper, stronger, and testable without a
renderer. `findVideoGaps(timeline)` becomes `findPlanGaps(plan)`. The verifier
keeps its `timeline_gaps` name so persisted rubric records stay comparable
across the migration.

**`caption_safe_area`** currently estimates the text box extent from font size;
`src/verify/timeline.ts` flags this as the one estimated number in the file. In
a real browser the caption nodes can be measured with
`getBoundingClientRect()`. The estimate becomes a measurement. `SAFE_AREA`
(`topClear: 0.1`, `bottomClear: 0.25`) is unchanged.

## Checkpoints

Each review iteration currently exports a binary `.palmier` package. A
HyperFrames project is a directory of text files, so a checkpoint becomes a
copy of the project directory: diffable and human-readable. "What changed
between iteration 2 and 3" becomes a diff.

## Error handling

The PRD section 0 discipline holds: no fallback branches, no degrading to a
mock, fail loudly. What changes is that the failure modes shrink. Gone are
"Editor not available", app-restart recovery, stale project cleanup, and import
hangs. Render failures surface from `@hyperframes/producer` directly. A missing
font, a missing asset file, or a failed render halts the run with the real
error.

## Testing

`build-timeline.ts` cannot be tested without a running desktop app, which is
why the existing tests cover the MCP wire protocol instead of the build logic.

- `planBeats` tests move unchanged.
- `compose.ts` is a pure function from a plan to HTML. Golden-file tests over a
  fixture `BeatPlan[]` cover treatments, the variant cycle, scrim decisions,
  splits, image overlays, and every `BuildOverrides` field, with no renderer.
- `findPlanGaps` gets direct unit tests.
- One end-to-end render test behind an env flag, asserting the output exists
  and ffprobes to the expected duration, resolution, and frame rate.

## Known risk: render wall-clock inside the review loop

The review loop runs up to 4 iterations, each of which builds *and* exports.
Palmier's export used a native, GPU-accelerated application; frame-by-frame
headless rendering of 45 seconds at 1080x1920 may be slower.

Mitigation, built in from the start rather than retrofitted: resolution is a
parameter of `render()`. If wall-clock is a problem, review iterations render
at reduced resolution and only the final master renders at 1080x1920. The
Layer-2 vision reviewer grades composition, legibility, and relevance rather
than pixel count, so reduced-resolution review frames should be acceptable.
Confirm against a real scored pair before relying on it: a reduced-resolution
render and a full-resolution render of the same iteration should receive
comparable rubric scores. Loudness normalization and the script-fidelity
verifier are unaffected by resolution.

This risk is accepted as a thing to measure during implementation, not to
design around in advance.

## Other open questions, to resolve during implementation

- **Fonts.** `text-styles.ts` names `Coolvetica Italic` and a `FONTS` map. The
  composition must load these via `@font-face` from local files. Confirm every
  named font is available as a file, not only installed in the OS.
- **Screen-recording legibility.** 2.4x zoom on a 1280x720 capture was tuned by
  eye against Palmier's scaler. Verify Hacker News headlines are still legible
  through HTML compositing at the same numbers, and retune if not.
- **Audio mixing.** The music bed is ducked to -20 dB with a 0.5s fade in and a
  1.5s smooth fade out, and each visual's own audio is muted to -60 dB. Map
  these onto HyperFrames audio tracks and confirm the resulting mix measures
  the same before loudness normalization.
- **CLI installation.** `@hyperframes/cli` is not installed on this machine.
  Decide whether the pipeline depends on the CLI, the SDK, or both.

## Sequencing

Five phases. Every phase leaves `main` shippable, and the migration can be
abandoned after any of them.

1. **Extract the pure core.** Move `planBeats` to `src/edit/plan-beats.ts` with
   its tests. No behavior change; Palmier still runs.
2. **Build the new path.** Add `compose.ts`, `styles.ts`, `captions.ts`,
   `render.ts`, `build.ts` behind `EDIT_BACKEND=hyperframes`, defaulting to
   `palmier`. Golden-file tests land here.
3. **Parity.** Render one real past run's `BeatPlan` both ways and compare beat
   by beat: framing, titles, captions, scrim, audio mix, duration.
4. **Port the verifiers.** `findPlanGaps` and the measured caption safe area.
   Flip the default to `hyperframes`.
5. **Delete Palmier.** Remove `src/palmier/**`, `correct-captions.ts`,
   `scrim.ts`, the `EDIT_BACKEND` flag, and the workaround code. Rename the
   `palmier_project_path` run-state field to `project_dir`.

## Out of scope

- Publishing. Manual until M5, unchanged by this work.
- Cloud or Lambda rendering.
- Widening `BuildOverrides` to exploit HTML-native motion.
- Any change to research, fact-checking, asset acquisition, or the gate flow.
