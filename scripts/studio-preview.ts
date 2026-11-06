/**
 * Re-compose an EXISTING run in the studio layout — no TTS, no asset spend.
 * For iterating on the compositor itself.
 *
 *   pnpm exec tsx scripts/studio-preview.ts <run-dir> [--patch beats.json] [--seconds N] [--brand X]
 *
 * --retheme: re-render the run's generated scenes on the studio backdrops (Playwright,
 *          no credits) into <run-dir>/studio-preview/ — old runs predate theming.
 * --music "<brief>": put a HeyGen catalog track under it (carved like a real run).
 * --patch: JSON object { "<beat_id>": { chapter, emphasis, source_note } } merged
 *          into the run's script (old runs predate those fields).
 * Writes <run-dir>/exports/<run_id>-studio.mp4 and prints the path.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../src/edit/build.js";
import { RunState, ScriptJSON, AssetManifest } from "../src/shared/schemas.js";
import { acquireGenerated } from "../src/assets/acquire.js";
import { themesForBeats } from "../src/edit/studio.js";
import { resolveCatalogMusic } from "../src/assets/music-catalog.js";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const runDir = resolve(args[0] ?? "");
if (!args[0]) {
  console.error("usage: tsx scripts/studio-preview.ts <run-dir> [--patch beats.json] [--seconds N]");
  process.exit(2);
}

const state = RunState.parse(JSON.parse(await readFile(join(runDir, "state.json"), "utf8")));
if (!state.script || !state.manifest) throw new Error(`${runDir} has no script/manifest`);
const patchPath = opt("--patch");
const patch: Record<string, Record<string, unknown>> = patchPath
  ? JSON.parse(await readFile(patchPath, "utf8"))
  : {};
const script = ScriptJSON.parse({
  ...state.script,
  beats: state.script.beats.map((b) => ({ ...b, ...(patch[b.id] ?? {}) })),
});
let manifest = AssetManifest.parse(state.manifest);
if (args.includes("--retheme")) {
  const themes = themesForBeats(script.beats);
  const out = join(runDir, "studio-preview");
  // One at a time: 15 concurrent software-WebGL Chromiums starved the machine
  // and a scene never got past its pre-roll.
  const assets = [];
  for (const a of manifest.assets) {
    const i = script.beats.findIndex((b) => b.id === a.beat_id);
    const beat = script.beats[i]!;
    if (beat.visual.type !== "generated") { assets.push(a); continue; }
    console.log(`re-theming ${beat.id} (${themes[i]})`);
    const vo = manifest.voiceover.find((v) => v.beat_id === beat.id)!;
    assets.push(await acquireGenerated(beat.visual.spec, out, beat.id, vo.durationS, themes[i]));
  }
  manifest = AssetManifest.parse({ ...manifest, assets });
}
const seconds = opt("--seconds");
const musicBrief = opt("--music");
if (musicBrief) {
  const total = manifest.voiceover.reduce((s, v) => s + v.durationS + 0.2, 0) + 2;
  const music = await resolveCatalogMusic(musicBrief, join(runDir, "studio-preview", "music"), total, console.log);
  manifest = AssetManifest.parse({ ...manifest, music });
}

const result = await build({
  script,
  manifest,
  workspace: { root: runDir, exports: join(runDir, "exports"), checkpoints: join(runDir, "checkpoints") },
  iteration: 0,
  style: "studio",
  brand: opt("--brand"),
  character: opt("--character"),
  maxSeconds: seconds ? Number(seconds) : undefined,
  exportName: `${script.run_id}-studio${opt("--character") ? "-" + opt("--character") : ""}.mp4`,
  onProgress: (m) => console.log(m),
});
console.log(`\nSTUDIO PREVIEW ${result.exportPath}`);
