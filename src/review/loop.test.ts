import test from "node:test";
import assert from "node:assert/strict";
import { hyperframesBuildArgs, resolveCaptionFontSize } from "./loop.js";
import { CAPTION_FONT_SIZE } from "../edit/styles.js";
import type { ScriptJSON, AssetManifest } from "../shared/schemas.js";
import type { Workspace } from "../run/workspace.js";

const script = { run_id: "test-run" } as unknown as ScriptJSON;
const manifest = {} as unknown as AssetManifest;
const workspace = {
  root: "/runs/x",
  assets: "/runs/x/assets",
  vo: "/runs/x/vo",
  exports: "/runs/x/exports",
  checkpoints: "/runs/x/checkpoints",
  statePath: "/runs/x/state.json",
} as unknown as Workspace;

test("the caption font size the loop reports to the reviewer equals the composition's real default", () => {
  assert.equal(resolveCaptionFontSize({}), CAPTION_FONT_SIZE);
});

test("resolveCaptionFontSize still honors an explicit override", () => {
  assert.equal(resolveCaptionFontSize({ captionFontSize: 72 }), 72);
});

test("hyperframesBuildArgs still carries the rest of the build call correctly", () => {
  const args = hyperframesBuildArgs(
    { script, manifest, workspace, brand: "kernelshorts", character: "blazer" },
    3,
    { captionCenterY: 0.5 },
    -18,
  );
  assert.equal(args.iteration, 3);
  assert.equal(args.musicDuckDb, -18);
  assert.deepEqual(args.overrides, { captionCenterY: 0.5 });
  assert.equal(args.script, script);
  assert.equal(args.manifest, manifest);
  assert.equal(args.workspace, workspace);
  assert.equal(args.brand, "kernelshorts");
  assert.equal(args.character, "blazer");
});

test("musicDuckDb is omitted (not set to undefined) when not provided — matches the original spread behavior", () => {
  const args = hyperframesBuildArgs({ script, manifest, workspace }, 1, {}, undefined);
  assert.ok(!("musicDuckDb" in args));
});
