# The asset vault

**Drop files in here. Nothing in this folder is committed to git** (see `.gitignore`) —
it holds large binaries and licensed material that must not be redistributed. Only this
README is tracked, so the *structure* is version-controlled while the *contents* stay local.

After adding or removing anything, run:

```bash
npm run vault:index
```

That scans every folder, `ffprobe`s each media file for real duration/format/loudness,
reads the license sidecars, writes `vault.index.json`, and upserts the catalog into the
`kernelshorts.assets` MongoDB collection. **The pipeline only ever sees indexed assets** —
a file you drop in but never index does not exist as far as the worker is concerned. That
is deliberate: it means the agent can never reach for an asset whose license and duration
we have not recorded.

## Where things go

| Folder | What goes in it | Used by |
| --- | --- | --- |
| `music/` | Licensed background tracks (`.mp3`/`.wav`). Put each source in its own subfolder — `music/ncs/`, `music/epidemic/` — so licence terms stay grouped. | Music bed (PRD §4) |
| `sfx/` | Short audio effects: whooshes, transitions, UI ticks, impacts. | Beat transitions, hook punch-ins |
| `brand/` | Channel identity: logo PNG (transparent), end-card, subscribe sting, watermark. | Intro/outro, overlays |
| `fonts/` | `.ttf`/`.otf` for captions and on-screen text. Install to the system too, or Palmier can't render them by name. | Captions, title cards |
| `stock/` | Hand-picked clips you want reused across runs, rather than re-fetched from Pexels/Pixabay each time. Organise by topic subfolder, e.g. `stock/servers/`. | B-roll fallback |
| `voice/` | Reference/sample voice audio, and any voice-clone source material. | TTS voice selection |

## License sidecars — required for `music/`, `sfx/`, `stock/`

Every media file must be accompanied by proof of licence, in one of two forms:

1. **A sidecar text file** next to it whose name starts with the media filename's stem.
   The NCS/Pixabay downloads already do this — `gorila-315977.mp3` +
   `beats-gorila-315977-license.txt`. Just keep them together; the indexer pairs them up.
2. **A `LICENSE.md` in the folder**, which then applies to every file in that folder.
   Use this for a subscription library where one licence covers the whole download.

A media file in `music/`, `sfx/`, or `stock/` with **neither** is flagged
`licenseStatus: "missing"` by the indexer and is **excluded from selection** by the
pipeline. It won't silently end up in a published video.

`brand/`, `fonts/`, and `voice/` are exempt — those are your own assets.

## Mood tags for music

Music is chosen by mood (`music_mood` in `ScriptJSON`). The indexer proposes tags from
each track's title and metadata, but you get the final word: edit `vault/music/tags.json`.

```json
{
  "gorila-315977.mp3": { "mood": ["upbeat-tech", "energetic"], "bpm": 128 },
  "night-detective-226857.mp3": { "mood": ["tense", "cinematic"] }
}
```

Anything you set there wins over the auto-proposed tags and survives re-indexing.

## Naming

Keep the original download filenames. They carry the provider's track ID, which is what
ties a file back to its licence page in a takedown dispute. The indexer derives a clean
display name for you; you do not need to rename anything by hand.
