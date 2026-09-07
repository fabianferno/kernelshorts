# Autonomous Shorts Pipeline — Build Spec v0.1

Daily HN-topic short-form videos, edited headlessly with HyperFrames, reviewed in an engineered loop, published to YouTube Shorts + Instagram Reels. Human gates via a companion web app.

> **Current state (post-migration).** This spec was written against Palmier
> Pro, a desktop NLE driven over a local MCP server — the pipeline could not
> run unless that app was open. Palmier has since been fully removed; the
> edit phase now composes an HTML project and renders it headlessly with
> HyperFrames, so the worker needs no GUI app running at all. Every mention
> of Palmier below is historical context for *why* a given constant or
> constraint exists (several tuned values, like `PALMIER_SCALE`, were
> calibrated against real Palmier output and are kept for that provenance),
> not a description of the current runtime.
>
> Two consequences worth knowing:
> - **Playwright/Chromium is now a hard runtime dependency of every run** —
>   the caption safe-area verifier launches a real browser to measure text
>   layout, and a Chromium launch failure aborts the review loop by design
>   rather than degrading to an unearned pass.
> - **Caption word timings come from a hosted whisper.cpp server**
>   (`WHISPER_URL`, default `https://whisper.crevn.xyz`) rather than a local
>   model. Nothing is downloaded; the trade is that captions need the
>   network, and a failure degrades that beat to estimated timings with a
>   loud warning rather than stopping the run.
> - The `hyperframes` CLI is a pinned devDependency (see README.md), invoked
>   via `pnpm exec`, not fetched fresh via `npx` on every call.

## 0. NON-NEGOTIABLE: no stubs, no mocks, no placeholders

**This applies to every phase, every milestone, and every file in this project.**

Do not stub. Do not mock. Do not write a placeholder that "will be wired up later." Do not return hardcoded sample data from a function that is supposed to call a real service. Do not write `// TODO: implement` and move on. Do not simulate an API response because the credential is missing. Do not fabricate a fake video, fake transcript, fake rubric score, or fake upload confirmation to make a pipeline stage appear to pass.

Every component ships calling the real thing: the real Algolia HN API, the real Palmier MCP server on `127.0.0.1:19789`, real Playwright browser recordings, the real Pexels/Pixabay APIs, the real TTS provider, real ffmpeg/ffprobe on real files, the real YouTube and Instagram publish endpoints.

**When you are blocked, stop and ask — do not invent a workaround.**

If you need an API key, an OAuth credential, a paid account, a file path, a licensing decision, a design choice, or access to anything at all: halt that work item, state plainly what you need and why, and ask. Waiting for a real credential is correct. Substituting a mock to keep moving is not. A blocked task that is honestly reported is a better outcome than a green checkmark over a mock.

**Evidence of realness is required.** A milestone is not complete on the basis of code that looks correct. Each one closes with a real artifact produced by a real run: an actual exported `.mp4` you can play, an actual HTTP response body from the live API, an actual `ffprobe` dump of a real file, an actual published post URL. Log the evidence in the run record. If you cannot produce the artifact, the milestone is not done — say so.

**Two clarifications, so this rule isn't misread:**

- *Tests* may use fixtures and recorded fixtures — that is what tests are for. The rule governs the production code path, which must never contain a mock branch, a `USE_FAKE_DATA` flag, or a fallback that returns synthetic data when a real call fails. Failures must surface as failures.
- *Provider adapters* (TTS, stock, publishing) are a legitimate interface pattern, not a stub — but every adapter written must have at least one real, working implementation behind it from day one. An interface with no live implementation is a stub wearing a costume.

### Credentials and access needed — ask for these up front

Gather these at kickoff rather than discovering them mid-build. Ask for any that are missing.


| Item                                                                  | Needed for         | Phase |
| --------------------------------------------------------------------- | ------------------ | ----- |
| Palmier Pro installed + running, project open                         | All editing        | M0    |
| Supabase project URL + service key                                    | Control plane      | M4    |
| Vercel account                                                        | Web app hosting    | M4    |
| TTS provider API key (ElevenLabs / OpenAI / Cartesia)                 | Voiceover          | M3    |
| Pexels + Pixabay API keys                                             | Stock B-roll       | M1    |
| Licensed music files (~30 tracks)                                     | Music bed          | M1    |
| Anthropic API key                                                     | Agent SDK sessions | M1    |
| Google Cloud project + YouTube Data API OAuth client                  | Publishing         | M5    |
| Instagram Business/Creator account + linked FB Page + Graph API token | Publishing         | M5    |
| Push/Telegram bot token                                               | Gate notifications | M4    |


Algolia's HN API needs no key. ffmpeg, ffprobe, and Playwright browsers install locally.

## 0.5. Locked decisions

- Format: 9:16 (1080×1920), 30–60 s target
- Narration: AI voiceover (TTS) + burned-in captions + music bed
- Visual sources, in order of preference per beat:
  1. **Playwright screen recordings** of the actual product — always best when the topic has a page worth showing
  2. **Generated scenes** (added 2026-08-13, see §4a) — HTML/CSS/SVG/three.js animated in a real browser and captured to video: code typing, terminal sessions, protocol diagrams, counted-up metrics, before/after comparisons, particle fields
  3. **Stock B-roll** (Pexels/Pixabay) — the default for anything with a real-world referent
  No AI-generated *clips* (no text-to-video models) → Palmier free tier suffices (editor + MCP server are free; only generative AI needs a subscription). Generated scenes are deterministic rendering, not generative video.
- Cadence: 1 video/day, launchd-triggered on the Mac
- Channels: YouTube Shorts, Instagram Reels
- Worker: macOS daemon, TypeScript + Claude Agent SDK, Palmier MCP at `http://127.0.0.1:19789/mcp`
- Control plane: Next.js (Vercel) + Supabase (Postgres, Realtime, Storage, Auth). Worker connects outbound only — no ports exposed on the Mac.

## 1. M0 — verify-first spike (do this before building anything)

1. Call `tools/list` on the live MCP server. Record exact tool names. Specifically: does an **export** tool exist? If not, fallback = AppleScript/System Events driving File → Export (fragile; treat as temporary).
2. Can MCP create or bind a **9:16 project**? If not: keep a pre-made 1080×1920 template `.palmier` project; the worker duplicates it per run.
3. Does `import_media` accept URLs or local paths only? Assume local; worker downloads everything into the run workspace first.
4. Import a test VO clip → `get_transcript` → confirm word-level timings (drives captions + fidelity checks).
5. Hand-drive Claude Code end-to-end: cut a 20 s vertical test short from two local clips + a VO file, export it. Time it; write down every failure mode you hit.

Everything in this spec assumes M0 passes. If export can't be automated, the design still works with one human tap per run at export — but say so honestly in the dashboard.

## 2. Components

### Control plane (hosted)

- Tables: `runs`, `run_events`, `artifacts`, `approvals`, `settings`
- Views: live run timeline (event feed per tool call), artifact viewer (ranked concepts with scores, research brief, script JSON, per-iteration rubric scores + video preview), approval inbox
- Notifications: web push and/or Telegram bot on gate-open, escalation, and failure
- Gate semantics: a run **blocks** on an open gate; a run is auto-expired when superseded by the next day's run. Actions: approve / reject / approve-with-comment (the comment becomes an input to the next edit brief).

### Worker (Mac)

- launchd daily trigger + watchdog: health-check the MCP endpoint, `open -a "Palmier Pro"` if down, alert the dashboard if unrecoverable
- One Claude Agent SDK session per phase; the Palmier MCP client is attached only during the edit phase
- Run workspace: `~/pipeline/runs/<date-slug>/{assets,vo,exports,checkpoints,state.json}`
- Retention: keep exports + state 90 days; purge assets/checkpoints after 7 days (disk fills fast at daily cadence)

### Shared schemas (zod, in `/shared`)

`ScriptJSON`, `AssetManifest`, `RubricScore`, `RunState`, event types. Everything that crosses a phase boundary is schema-validated.

## 3. Phase 1 — research → script

1. **Ingest:** Algolia HN API, front-page window = last 24 h at trigger time.
2. **Filter:** score threshold, dedupe against published history, drop non-demonstrable / paywalled / political items.
3. **Rank** (LLM, 1–5 per criterion + written justification): visual demonstrability, novelty, audience breadth, story-arc potential, asset availability (can we screen-record it?), risk (licensing/controversy). Weighted sum → top pick; top 3 shown in dashboard.
4. **Research:** fetch article + product site + docs + HN comments → research brief with a claim→source table.
5. **Fact-check verifier:** every claim in the script must map to a source URL + supporting excerpt. Unsourced claim → rewrite (max 2 loops) → else escalate. For review-style content, a confidently wrong claim is the worst failure mode; this verifier is not optional.
6. **Script JSON** (schema below).
7. **TTS:** generate VO per beat (provider adapter — ElevenLabs / OpenAI TTS / Cartesia; pick via a quality bake-off in M3). Measure durations → set beat durations. Audio-first: VO timing drives the timeline.
8. **Asset manifest** per beat: screen-record spec (URL, scripted actions, viewport), stock query, or still.

→ **Gate A (script approval):** dashboard shows script, VO audio preview, asset plan, sources. One tap.

### ScriptJSON example

```json
{
  "run_id": "2026-08-12-toolname",
  "topic": { "hn_id": 123, "title": "...", "url": "https://..." },
  "target_duration_s": 50,
  "music_mood": "upbeat-tech",
  "beats": [
    {
      "id": "hook",
      "vo_text": "This tool turns any repo into living docs.",
      "on_screen_text": "Repo → docs in 30s?",
      "visual": {
        "type": "screenrec",
        "url": "https://producturl.com",
        "viewport": "mobile",
        "actions": ["goto", "click #demo", "scroll 600"]
      },
      "max_duration_s": 4
    }
  ],
  "claims": [{ "text": "...", "source_url": "...", "excerpt": "..." }],
  "cta": { "vo_text": "...", "on_screen_text": "Follow for daily HN finds" }
}

```

## 4. Phase 2 — assets + edit

### Asset acquisition (outside Palmier)

- **Screen recordings (Playwright):** two modes per beat —
  - `mobile` viewport 1080×1920: native vertical, sites render mobile layouts that fill the frame
  - `desktop` 1920×1080: record wide, plan a crop/zoom/pan in the edit (Ken Burns over dashboards)
  - Record webm → ffmpeg → H.264 MP4 before import.
- **Fallbacks** when the topic isn't recordable (papers, repos): README/code scroll capture, article screenshots, generated scenes (§4a), stock.
- **Stock:** Pexels + Pixabay APIs, portrait-orientation filter, ≥1080p; store license metadata per asset. (Confirm current API quotas during build.)
### 4a. Generated scenes — the fix for abstract topics

**Why this exists.** The first fully autonomous run (2026-08-13, "HTML over WebSockets") scored `visual_relevance` **2 on all four review iterations**. The loop re-acquired every clip with genuinely better queries — "bidirectional network connection diagram", "author's site showing 600 simultaneous readers" — and the score did not move. The diagnosis was structural, not a tuning problem: **no stock library contains footage of server-rendered HTML arriving over a socket.** Most of HN's front page is infrastructure, protocols, languages and algorithms — things with no photographable referent. Stock B-roll over that narration is decorative at best and misleading at worst.

**What it is.** A closed set of parameterised scenes, rendered in a real headless browser at 1080x1920 and captured to H.264 exactly like a screen recording:

| scene | shows | good for |
| --- | --- | --- |
| `code` | syntax-highlighted source typing itself in | "here is the API" |
| `terminal` | a command session with output | installs, benchmarks, CLI tools |
| `diagram` | boxes, arrows, packets moving along edges | protocols, architectures, data flow |
| `metric` | one big number counting up | benchmark results, scale claims |
| `compare` | before/after columns | migrations, tradeoffs |
| `particles` | a three.js field under a title | atmosphere only — it asserts nothing |

**Closed set, not free-form HTML.** The model supplies the *content* (the code, the labels, the numbers), which is what it is good at. The animation, timing and typography are ours, written once and verified once. A model authoring arbitrary CSS keyframes fails in ways that surface only as a blank rectangle in a finished video — and a blank rectangle passes every check that is not looking for it.

**Verification is mandatory** (PRD §5 Layer 1 applies to every generated clip): correct resolution and duration, no black frames, and **frames must actually differ over time** — a scene that renders but never animates is the exact failure mode this feature invites. Console errors during render fail the clip loudly rather than yielding a still frame.

**Stock remains the default** for anything real: a person typing, a server room, a city at night. Generated scenes are for the ideas.

- **Music:** local pre-licensed library (~30 tracks tagged by mood) as default. Optional upgrade: Epidemic Sound via its MCP server (Palmier's own FAQ describes this combo) — subscription required. Never scrape music.

### Edit agent (Palmier MCP)

- Duplicate the 9:16 template project → import VO + assets
- Audio-first layout: VO clips sequential on the audio track; visuals aligned to beat boundaries; transforms/keyframes for crop-pan on desktop recordings; text overlays per beat; captions generated from Palmier transcription of the VO track; music bed ducked (start around −12 to −18 dB under VO, keyframed fades in/out — tune by ear in M1)
- Checkpoint the project file after each successful pass; use the agent undo stack to revert bad edits without touching prior good state

## 5. Review loop (the loop-engineering core)

**Layer 1 — deterministic verifiers (code, run first, cheap):**

- ffprobe: duration in range, 1080×1920, expected fps, audio stream present
- Loudness: ffmpeg loudnorm scan; target ≈ −14 LUFS integrated (accept roughly −16 to −13; tune after first uploads)
- ffmpeg blackdetect / freezedetect: no black or frozen frames
- `get_timeline`: no gaps on the video track
- Caption safe area: text clip positions keep roughly the bottom 25% and top 10% clear of critical text (platform UI overlays; tune against real uploads)
- Script fidelity: transcript of export ≈ script VO text

**Layer 2 — reviewer agent (fresh context, multimodal):**

- Input: frames sampled ~1 fps + beat-boundary frames, transcript, approved script. Never the editor's reasoning (prevents self-grading drift).
- Output: rubric 1–5 with written justification — hook (first 2 s), pacing, visual-to-script relevance per beat, caption legibility/timing, audio mix, coherence — plus a timestamped fix list. Vague feedback ("make it punchier") is rejected by schema; every fix names a timestamp and an action.

**Loop policy:**

- Exit: all Layer-1 checks pass AND every rubric dimension ≥ 4
- Iterate: orchestrator compiles fixes into a structured edit brief → fresh editor session gets script + current timeline state + brief (not accumulated chat history)
- Stop: max 4 iterations, OR no score improvement across 2 consecutive iterations → escalate (**Gate B**, conditional) with video + reviewer notes
- Error discipline: never retry an identical action after an identical error; classify recoverable (retry differently) vs blocker (escalate immediately)

## 6. Phase 3 — export + publish

- Export via MCP tool if M0 confirmed it; else AppleScript fallback. Always re-verify the output file with ffprobe.
- **Gate C (publish approval):** video preview + per-platform title/description/hashtags. Mandatory at first; per-channel auto-publish flag once you trust it.
- **YouTube (Data API** `videos.insert`**):** unverified API projects have uploads locked to private until a compliance audit passes. Decide at M5: complete the audit, or route through an aggregator (Ayrshare / Blotato / upload-post). One upload/day is far inside any quota regime.
- **Instagram (Graph API Reels publish):** requires a Business/Creator account linked to a Facebook Page. Verify the current flow at build time.
- Metadata agent: title ≤100 chars, description, hashtags; store returned platform IDs + links on the run record.
- Check current platform policies on AI-disclosure and repetitive/inauthentic content before scaling past the first few uploads.

## 7. Build order

- **M0** — verification spike (1 day). De-risks everything above.
- **M1** — edit agent: hardcoded ScriptJSON + local assets → finished 9:16 video. This is the risk core; build it first.
- **M2** — review loop: verifiers, reviewer, loop policy, checkpointing.
- **M3** — research phase + TTS bake-off + fact-check verifier.
- **M4** — web app: runs, event stream, artifacts, gates, notifications.
- **M5** — publish: YouTube first (audit-vs-aggregator decision), then Instagram.
- **M6** — scheduler, watchdog, retention → switch on daily cadence.

Each milestone is sequential and each one ends with a real artifact (§0). A later milestone never starts by faking an earlier one: M2's review loop reviews a real exported file from M1, not a sample video. M5 publishes a real video produced by M1–M4, not a test clip.

## 8. Open items

- TTS provider: Use soniox TTS
- Publish path: API audit vs aggregator (M5)
- Music library source + initial 30 tracks i will give these 
- Cost telemetry from day 1: tokens + wall-clock per phase per run; review after week 1 — the vision review loop is the expected cost center - good thought keep these in mind

