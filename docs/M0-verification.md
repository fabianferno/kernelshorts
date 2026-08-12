# M0 — verification spike (PRD §1)

Run date: 2026-08-12. Live Palmier Pro MCP at `http://127.0.0.1:19789/mcp`.
All findings below come from real calls against the live server and real files on disk.

## 1. Does an export tool exist?

**Yes.** `export_project` renders real video (H.264 / H.265 / ProRes), takes an absolute
`outputPath`, and returns `{jobId, status}`. Progress and completion are polled with
`manage_exports {action: "list"}`. **No AppleScript fallback is needed** — the PRD's
fragile-fallback branch is dead code and should not be built.

It also exports `xml`, `fcpxml`, and `palmier` (self-contained project package). The
`palmier` mode is the checkpointing primitive for §4 ("checkpoint the project file after
each successful pass").

## 2. Can MCP create/bind a 9:16 project?

**Yes, natively.** `manage_project {action:"create", aspectRatio:"9:16", quality:"1080p", fps:30}`
returned `resolution: 1080x1920, fps: 30`. **No pre-made `.palmier` template is required.**

### ⚠️ Failure mode found — canvas hijack on first import

Placing the first landscape (1280×720) clip silently **re-set the project canvas to
1280×720**, with only an advisory `note` in the response. A worker that trusts its
create-time settings would export a landscape "short".

**Mitigation (mandatory in the edit agent):** after the first `add_clips` of the run,
re-assert `set_project_settings {width:1080, height:1920}` and verify `get_timeline`
reports `width:1080, height:1920` before proceeding. Treat a mismatch as a hard failure.

### Fitting landscape footage to 9:16

After the canvas is restored, clips auto-fit *letterboxed* (`transform.height: 0.316`
for 16:9 into 9:16). To fill the frame, set `transform {width: 3.165, height: 1}`
(1/0.316). This is also the anchor for the PRD's Ken Burns crop-pan: keyframe
`centerX`/`centerY` within the overflowing width.

## 3. Does `import_media` accept URLs or local paths?

**Both.** `path` (absolute file *or* directory — directories import recursively and mirror
their structure as media folders) resolves inline with `status:"ready"`. `url` (HTTPS only,
≤1 GB) downloads in the background and must be polled via `get_media {ids:[...]}` until
`generationStatus` clears. `bytes` (base64, ≤~11 MB) and `matte` also work.

Accepted: video `mov/mp4/m4v`, audio `mp3/wav/aac/m4a/aiff/aifc/caf/flac`, image
`png/jpg/jpeg/tiff/heic`. **webm is rejected** — this confirms the PRD's Playwright
requirement to transcode webm → H.264 MP4 *before* import.

The PRD's assumption ("assume local; download everything into the run workspace first")
stands as the right default: local paths are synchronous and need no polling.

## 4. Word-level VO timings

**Confirmed.** `get_transcript {trackIndex: <VO track>}` returned 63 words as
`[index, text, startFrame]` rows in **project frames**, with `transcriptionSource: "cloud"`
and run-length speaker turns. A word runs to the next word's start.

This satisfies both dependent features:
- **Captions** — `add_captions` consumes the same transcription and produced 19 caption
  clips as one `captionGroupId`, restylable as a group.
- **Script-fidelity check (§5 Layer 1)** — transcribe the timeline, diff against the
  approved `ScriptJSON` VO text.

Note: transcription is cloud when the signed-in account has credits, else local. The
verifier must record which was used, since accuracy differs.

## 5. End-to-end: real 20s vertical short

Built and exported without human intervention:

| Step | Call |
| --- | --- |
| Create canvas | `manage_project` create 9:16 / 1080p / 30fps |
| Import VO | `import_media` path → `vo_test.wav` (20.0s, real audio) |
| Import clips | `import_media` path (directory) → `clipA.mov`, `clipB.mov` |
| Lay out | `add_clips` — VO 0–600, clipA 0–300, clipB 300–600 |
| Restore canvas | `set_project_settings` 1080×1920 (see §2 failure mode) |
| Fill frame | `set_clip_properties` transform width 3.165 |
| Duck source audio | `set_clip_properties` volumeDb −60 on linked audio ids |
| Captions | `add_captions` trackIndex=VO, maxWords 4, centerY 0.68 |
| Export | `export_project` H.264 → absolute path |

**Artifact:** `~/pipeline/runs/m0-spike/exports/m0_test_short.mp4`

Real `ffprobe` output:

```
codec_name=h264  codec_type=video  width=1080  height=1920  r_frame_rate=30/1  nb_frames=600
codec_name=aac   codec_type=audio  nb_frames=940
duration=20.000000  size=26103272
```

`blackdetect` (d=0.3, pic_th=0.98): **0 black segments.**

Loudness scan: **Input Integrated −24.9 LUFS**, True Peak −0.2 dBTP, LRA 7.7 LU.

### ⚠️ Failure mode found — export is not loudness-normalized

−24.9 LUFS against the PRD's ≈ −14 LUFS target. Palmier exports at source level; it does
**not** normalize. The Layer-1 loudness check will fail every export as written.

**Mitigation:** the loudness check must be a *normalize-then-verify* stage — run an
`ffmpeg loudnorm` two-pass over the exported file to produce the publish master, then
ffprobe/loudnorm-verify that master. Publishing must use the normalized file, never
Palmier's raw export.

## 6. Timing

The full sequence (create → import → lay out → caption → export → verify) ran in under
three minutes of wall clock, with the 20s H.264 render itself taking ~30s. Daily cadence
is not remotely constrained by editor throughput; per §8, the cost centre will be the
vision review loop, not the edit.

## Other notes for the build

- **Track indices shift.** `add_captions` created a new top video track and returned
  `"Track indices shifted — re-read get_timeline before the next index-based call."`
  The edit agent must re-read `get_timeline` after any track-creating call, or address
  tracks by stable `trackId`.
- **Linked audio is nested.** A video clip's audio partner appears as `audio: {id, track}`
  inside the video clip, not as its own row. Duck/mute it by that nested id.
- **Source spans are seconds, timeline positions are frames.** `add_clips` takes
  `source: [startSec, endSec]` but `startFrame` in project frames. Never convert by hand.
- **Mixed fps.** 24fps sources on a 30fps timeline are placed and interpreted at 30fps
  without conforming. Standardize assets to the project fps during acquisition.

## Verdict

**M0 passes.** Export is fully automatable — no human tap per run, no AppleScript. The
two real failure modes above (canvas hijack, no loudness normalization) are folded into
the M1/M2 designs rather than discovered later.
