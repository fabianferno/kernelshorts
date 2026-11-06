import test from "node:test";
import assert from "node:assert/strict";
import { checkpointPathFor, wordTimingsForBeat, build, renderFinalMaster } from "./build.js";
import type { RenderOptions } from "./render.js";
import type { ComposeOptions, ComposeResult } from "./compose.js";
import type { ScriptJSON, AssetManifest } from "../shared/schemas.js";

/** Minimal fixtures — only the fields planBeats/build read. */
const script = {
  run_id: "test-run",
  beats: [{ id: "hook", vo_text: "First line.", on_screen_text: "HOOK" }],
} as unknown as ScriptJSON;

const manifest = {
  voiceover: [{ beat_id: "hook", path: "/vo/hook.wav", durationS: 2 }],
  assets: [
    { beat_id: "hook", path: "/v/a.mp4", kind: "stock", width: 1280, height: 720, durationS: 10 },
  ],
  overlays: [],
} as unknown as AssetManifest;

const emptyScript = { run_id: "empty-run", beats: [] } as unknown as ScriptJSON;
const emptyManifest = { voiceover: [], assets: [], overlays: [] } as unknown as AssetManifest;

const workspace = { root: "/runs/x", exports: "/runs/x/exports", checkpoints: "/runs/x/checkpoints" };

/** A build() with every dep faked, so no filesystem or CLI is touched. Each
 *  fake records into `calls` in the order it ran. */
function fakeDeps(calls: string[], qualities: RenderOptions["quality"][] = []) {
  return {
    wordTimingsFor: async () => [],
    compose: async (o: ComposeOptions): Promise<ComposeResult> => {
      calls.push("compose");
      return { projectDir: o.projectDir, indexPath: `${o.projectDir}/index.html`, totalSeconds: 2 };
    },
    copyProject: async () => {
      calls.push("checkpoint");
    },
    host: async () => ({ brand: "test", accent: "#3B82F6", hostPoses: [], hostPoseDir: "", hostMeta: {}, hostMouth: [] }),
    carveBed: async (o: { musicPath: string }) => o.musicPath,
    render: async (o: RenderOptions) => {
      calls.push("render");
      qualities.push(o.quality);
      return o.outputPath;
    },
  };
}

test("a checkpoint is a directory copy, not a binary package", () => {
  const p = checkpointPathFor("/runs/x/checkpoints", "run-1", 2);
  assert.ok(!/\.[a-z0-9]+$/i.test(p), `checkpoint path ${p} looks like it has a file extension`);
  assert.match(p, /run-1-v2$/);
});

test("wordTimingsForBeat returns the transcriber's timings when they exist", async () => {
  const logs: string[] = [];
  const timings = await wordTimingsForBeat(
    "hook",
    "/vo/hook.mp3",
    "hi",
    (m) => logs.push(m),
    async (_voPath, voText) => [{ word: voText, startS: 0, endS: 0.3 }],
  );
  // The script text reaches the transcriber — it is the ground truth for the
  // WORDS, not a hint, so a caller that failed to thread it through would
  // silently hand whisper's own transcript to the captions.
  assert.deepEqual(timings, [{ word: "hi", startS: 0, endS: 0.3 }]);
  assert.equal(logs.length, 0);
});

test("wordTimingsForBeat logs loudly and falls back to empty on no words", async () => {
  const logs: string[] = [];
  const timings = await wordTimingsForBeat(
    "hook",
    "/vo/hook.mp3",
    "hi",
    (m) => logs.push(m),
    async () => [],
  );
  assert.deepEqual(timings, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /CAPTIONS DEGRADED/);
  assert.match(logs[0]!, /ESTIMATED/);
});

test("wordTimingsForBeat logs loudly and falls back to empty when transcribe throws", async () => {
  const logs: string[] = [];
  const timings = await wordTimingsForBeat(
    "hook",
    "/vo/hook.mp3",
    "hi",
    (m) => logs.push(m),
    async () => {
      throw new Error("hyperframes: command not found");
    },
  );
  assert.deepEqual(timings, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /CAPTIONS DEGRADED/);
  assert.match(logs[0]!, /command not found/);
});

test("wordTimingsForBeat's alarm cannot be silenced by omitting onProgress — console.warn always fires", async () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => warnings.push(m);
  try {
    // No onProgress passed downstream — only console.warn can carry the alarm.
    await wordTimingsForBeat("hook", "/vo/hook.mp3", "hi", () => {}, async () => []);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /CAPTIONS DEGRADED/);
});

test("build checkpoints the project BEFORE rendering it", async () => {
  const calls: string[] = [];
  await build({ script, manifest, workspace, iteration: 1 }, fakeDeps(calls));
  assert.deepEqual(calls, ["compose", "checkpoint", "render"]);
});

test("build renders draft by default and high only when opts.final is true", async () => {
  const draftQualities: RenderOptions["quality"][] = [];
  await build({ script, manifest, workspace, iteration: 1 }, fakeDeps([], draftQualities));
  assert.deepEqual(draftQualities, ["draft"]);

  const highQualities: RenderOptions["quality"][] = [];
  await build({ script, manifest, workspace, iteration: 1, final: true }, fakeDeps([], highQualities));
  assert.deepEqual(highQualities, ["high"]);
});

test("build never infers final quality from iteration count alone", async () => {
  const qualities: RenderOptions["quality"][] = [];
  // A high iteration number with no `final` flag must still render draft —
  // the review loop cannot know in advance which iteration wins.
  await build({ script, manifest, workspace, iteration: 4 }, fakeDeps([], qualities));
  assert.deepEqual(qualities, ["draft"]);
});

test("build names the export by run id and iteration", async () => {
  let exportPath = "";
  const result = await build(
    { script, manifest, workspace, iteration: 3 },
    {
      ...fakeDeps([]),
      render: async (o: RenderOptions) => {
        exportPath = o.outputPath;
        return o.outputPath;
      },
    },
  );
  assert.match(exportPath, /test-run-v3\.mp4$/);
  assert.equal(result.exportPath, exportPath);
});

test("build throws on an empty beat plan before composing anything", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => build({ script: emptyScript, manifest: emptyManifest, workspace, iteration: 1 }, fakeDeps(calls)),
    /Empty beat plan/,
  );
  assert.deepEqual(calls, []);
});

test("renderFinalMaster always requests high quality, from the checkpoint directory", async () => {
  const seen: RenderOptions[] = [];
  const result = await renderFinalMaster(
    { checkpointPath: "/runs/x/checkpoints/test-run-v2", exportPath: "/runs/x/exports/test-run-master.mp4" },
    async (o: RenderOptions) => {
      seen.push(o);
      return o.outputPath;
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.quality, "high");
  assert.equal(seen[0]!.projectDir, "/runs/x/checkpoints/test-run-v2");
  assert.equal(result, "/runs/x/exports/test-run-master.mp4");
});
