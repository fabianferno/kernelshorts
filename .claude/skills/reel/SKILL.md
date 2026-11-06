---
name: reel
description: Make a ~110 s vertical explainer reel from a link (HN item, article) or a topic — research, script, voice, render, review — with three human approval gates. Use when the user says "/reel <url or topic>", "make a reel/video about…", or asks to turn an HN post or article into a video.
---

# /reel — one line in, a reel out, three gates

Format and style are reverse-engineered in `docs/oneprompt-teardown.md` — read
§2–§5b before writing the first script of a session.

## Who does what (keeps the user's Claude Code plan doing the work)

| Job | Done by |
|---|---|
| Reading the source, research, script, hooks, judging frames, writing scene code | **You (Claude Code)** — no API calls |
| Images (host poses, textures, logos) and any Gemini-specific task | **`agy`** CLI (`image-generator` sub-agent, free; ~12 images / 4.5 h quota) |
| Voice + word timings | ElevenLabs (free tier — every character counts, see Budget) |
| Bedrock | **Only** the unattended server path. Never in this skill. |

## Workflow

### 0 · Source
```
pnpm exec tsx scripts/source.ts <HN url | HN id | article url | reel/short url>   # → ~/pipeline/sources/<slug>.md
pnpm exec tsx scripts/source.ts --front                          # browse today's HN
```
**A reel / Short / TikTok as the source** (`source.ts <video url>`): it's
downloaded, transcribed (Soniox STT) and sampled into `hook.jpg` / `sheet.jpg`
— Read both sheets to see how it's built. Then REMAKE it: same facts and
angle, but every line freshly written in our formula, our props and our host;
verify its numbers against a primary source; credit the creator in a
`source_note` ("via @handle"). Never reuse its wording, footage or visuals.

Read the whole file. The HN comments hold the best counter-arguments and
numbers. Verify any number you will say out loud against the article text;
if a claim needs a source beyond the article, look it up and put it in that
beat's `source_note`. No invented facts — say less instead.

### 1 · Script → GATE 1
Write `~/pipeline/scripts/<slug>.json` (ScriptJSON, `src/shared/schemas.ts`).
Target **75–88 s — hard cap 90 s** (≈ 200–230 words; voices run ~2.65 words/s), **8–10 beats**, using the formula:

1. **Hook (≤5 s)** — "Did you know…" + concrete, surprising fact with a name and a number.
2. **Open loop** — restate as a *why/how* question.
3. **Reframe** — short riddle-answer ("AI doesn't just think. It sweats.").
4. **Personal stake** — one "I…" line from the user's life (developer; runs; loves movies). Ask the user if you don't have a true one; never invent biography.
5. **"Imagine…"** — a physical analogy that can be drawn.
6. **First / Second / Third** — structure (drives host poses).
7. **Twist** — "But here's the catch." around 55–70 s.
8. **"That's also why…"** → one actionable takeaway for the viewer.
9. **Callback** — the hook fact again, with its new meaning.
10. **CTA** — "Follow for more / send this to the friend who…".

Style: sentences of 3–12 words, present tense, every claim has a number + named
source. Per beat fill `chapter` (THE SETUP / THE SUSPECT / THE CATCH / YOUR PART…,
none on the hook), `emphasis` (exact words from `vo_text` to box-highlight),
`source_note` ("Nature, 2020"), `visual_brief` (what the hero object is and does),
and a renderable `visual` (see Renderer status).

Optional **hook lab** (only if the user asks for options, or the hook feels weak):
write 5 hooks yourself; optionally get 5 more from Gemini for a different angle:
`agy -p "<source summary + formula step 1> Write 5 hooks, one per line." --model gemini-4-argon-high`.
Pick one, show the runners-up.

**Delivery tags (you are the auto-tagger).** Write performance into `vo_text`
with Soniox syntax — the pipeline sends it verbatim to Soniox, converts it to
punctuation for Sarvam/ElevenLabs (never read aloud), and strips it from
captions (`src/tts/delivery.ts`):
- Tags go BEFORE the words they colour: `[excited]`, `[curious]`, `[serious]`,
  `[playful]`, `[sarcastic]`, `[warm]`, `[dramatically]`, `[whispering]`,
  `[softly]`, `[slowly]`, `[laughs]`, `[chuckles]`, `[sighs]`, `[gasps]`,
  `[pause]`, `[long pause]` (full list in delivery.ts SONIOX_TAGS).
- `*word*` stresses one word; UPPERCASE = loud; `sooo` elongates; `…` trails
  off; `—` cuts off; `?!` incredulous.
- Sparingly: ~1 tag per beat, never more than 2 stacked; the words must
  carry the emotion too (`[excited] SURPRISE!!!`, not `[excited] okay.`).
  Typical arc: hook `[curious]`/`[excited]`, reframe `[serious]`, twist
  `[dramatically]` or `[pause]`, takeaway `[warm]`, CTA `[playful]`.
- `emphasis` (caption highlight) matches the spoken words, without asterisks.

Then run:
```
pnpm exec tsx scripts/check-script.ts ~/pipeline/scripts/<slug>.json
```
Fix every ERROR. Show the user: hook, the beat table, estimated length,
ElevenLabs characters, warnings. **Stop. Gate 1 = user approves the script.**

### 2 · Voice + assets → GATE 2
```
pnpm exec tsx src/pipeline.ts ~/pipeline/scripts/<slug>.json --stop-after-assets
```
Report the measured VO length per beat (`RESULT` line). Gate 2 should be the
first 10 seconds rendered on their own; until the hook-only render lands, Gate 2
is: play the hook VO (`afplay <workspace>/vo/<first-beat>.wav`) and confirm the
voice and pacing. **Stop for approval.**

### 3 · Render + self-review → GATE 3
```
pnpm exec tsx src/pipeline.ts --resume <run-slug> --self
pnpm exec tsx scripts/review-sheet.ts ~/pipeline/out/<run-id>.mp4
```
`--self` = one build + deterministic Layer-1 checks, no Bedrock. Then **look at
both sheets yourself** (Read the .hook.jpg and .sheet.jpg). Judge: does something
change every 2–4 s; is every frame's hero visual readable on a phone; captions in
the safe area; the hook frame alone makes you stop scrolling. Fix by editing the
script/visuals and re-running step 3 (voice is cached — zero credits if the VO
text is unchanged). **Gate 3 = user approves the final cut.** The file is in
`~/pipeline/out/`. Publishing is manual (automation is the last milestone).

## Music
`music_mood` is a natural-language brief ("calm curious documentary, subtle
pulse") for the HeyGen catalog (`MUSIC_SOURCE=heygen`, needs `heygen auth
login --oauth`); it's resolved BEFORE the voice so a missing sign-in fails
without spending credits. The bed is carved under the voice at build time
(`src/edit/bed.ts`: low loudness, 1–3 kHz dip, VO-keyed duck). Never use the
vault music. `MUSIC_SOURCE=none` renders without a bed.

## Budget rules
- ElevenLabs free tier ≈ 10k chars/month; a reel ≈ 1.6–1.9k. Never change
  `vo_text` after Gate 2 without telling the user it costs credits. Cache key =
  text + neighbouring beats' text + voice + model, so editing one beat also
  re-voices its neighbours.
- Voice comes from the character (see below); `--voice provider:id` to override.

## Renderer status (update this when the compositor changes)
Default layout is **studio** (`src/edit/studio.ts`): themed light/dark backdrop
per chapter, chapter chrome (brand + pill + progress), 1–3 word captions at the
top in Timeless Sans with `emphasis` in a selection box, `source_note`
footnotes, and the host (pose library swapped on trigger words, ≤1.7 s holds,
mouth driven by the VO loudness, poses scaled/aligned on the head).

**Hero visuals — prefer `prop3d`.** `{"type":"generated","spec":{"scene":"prop3d","prop":"<id>", "params":{…},
"camera":"push|orbit|static", "counter":{"from","to","prefix","suffix","label","decimals"}, "tag":"…"}}`.
List props + params: `pnpm exec tsx scripts/prop-preview.ts --list`. When a beat
needs an object the library lacks, WRITE A NEW PROP in `src/props/library.ts`
(primitives + kit materials, rounded edges, one clear motion), preview it with
`pnpm exec tsx scripts/prop-preview.ts <id> --theme dark|light`, Read the sheet,
fix, keep. Other generated scenes (`metric`, `compare`, `diagram`, `code`,
`terminal`, `particles`) still work; `stock`/`still`/`screenrec` render as a
framed card (screen recordings of articles are unreadable — avoid).

Gate 2 hook render: `pnpm exec tsx src/pipeline.ts --resume <slug> --hook`.
Layout iteration with zero spend: `scripts/studio-preview.ts <run-dir> [--retheme] [--character id]`.

## Characters, voices, brand
`vault/characters/<id>/character.json` = name, gender, and the voice:
`{"provider": "elevenlabs" | "soniox" | "sarvam", "voiceId": "…", "model"?, "language"?, "label"?}`.
The script's `"character"` (or `--character`) picks the host AND its voice;
`--voice provider:id` overrides for one run. Default host is
`vault/brand/brand.json` → `defaultCharacter`; brand name, accent and
`musicStyle` live there too.

- **List voices:** `pnpm voices [elevenlabs|soniox|sarvam]` — shows which your
  plans can use. **Hear one:** `pnpm voices --sample sarvam:priya`.
- ElevenLabs returns word timings with the audio; Soniox and Sarvam voices are
  transcribed with Soniox STT for timings (one extra call per beat, cached).
- ElevenLabs free plan: premade voices only. Sarvam needs `SARVAM_API_KEY`.
- Current: `cortana` (female, default) → ElevenLabs Jessica; `fabian` (male)
  → Soniox "Fabian new" (the user's own clone).
- Sarvam defaults to `bulbul:v4-flash`; its speakers are personas
  (`ritu_en_reels`, `simran_en_ads`, `varun_en_suspense`…). Expression on
  Sarvam = persona style + `"temperature"` (0.01–1) in the voice spec.

New character: make the folder, drop `reference.png`, write `character.txt` +
`character.json`, then `scripts/gen-host-until-done.sh <id>` (Gemini quota:
~12 images / 4.9 h).

## Assets the user gives you
`pnpm assets:add <file-or-folder>` (or files dropped in `vault/inbox/`, then
`pnpm assets:add`). Fonts → `vault/fonts/`, green-screen video → keyed alpha
WebM in `vault/overlays/`, images → `vault/images/`, audio → `sfx`/`music`.
Check `vault.index.json` — a `licenseStatus: "missing"` asset must not be used
in a published reel until the user confirms its licence.

