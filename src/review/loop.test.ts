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

/**
 * This is the plumbing that shipped BROKEN once already: `LoopOptions.captionHighlight`
 * reached `compose()` (proven by compose.test.ts) and `build()` (proven by
 * build.test.ts's ComposeOptions forwarding), but the review loop's own
 * assembly of the hyperframes build call omitted it. `hyperframesBuildArgs`
 * is the exact assembly point that dropped it, so this test closes the loop
 * end to end from what the LOOP receives to what `build()` is handed.
 */
test("a captionHighlight the loop receives reaches the hyperframes build() call", () => {
  const args = hyperframesBuildArgs(
    { script, manifest, workspace, captionHighlight: "pop" },
    2,
    {},
    undefined,
  );
  assert.equal(args.captionHighlight, "pop");
});

test("captionHighlight is undefined (not silently defaulted) when the loop was not given one", () => {
  const args = hyperframesBuildArgs({ script, manifest, workspace }, 1, {}, undefined);
  assert.equal(args.captionHighlight, undefined);
});

/**
 * A fourth unit-conversion bug hid here: the review loop told the vision
 * reviewer captions default to 31px (Palmier's pre-rescale value) while the
 * composition actually renders them at 56px (CAPTION_FONT_SIZE, post
 * PALMIER_SCALE). Asserting a literal 56 in both places would not have
 * caught the original bug's shape — it would just be two hardcoded numbers
 * that happened to agree. This asserts the loop's reported default IS the
 * composition's real default (the same value, from the same source), so the
 * two cannot drift apart again without this test failing.
 */
test("the caption font size the loop reports to the reviewer equals the composition's real default", () => {
  assert.equal(resolveCaptionFontSize({}), CAPTION_FONT_SIZE);
});

test("resolveCaptionFontSize still honors an explicit override", () => {
  assert.equal(resolveCaptionFontSize({ captionFontSize: 72 }), 72);
});

test("hyperframesBuildArgs still carries the rest of the build call correctly", () => {
  const args = hyperframesBuildArgs(
    { script, manifest, workspace, captionHighlight: "block" },
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
});

test("musicDuckDb is omitted (not set to undefined) when not provided — matches the original spread behavior", () => {
  const args = hyperframesBuildArgs({ script, manifest, workspace }, 1, {}, undefined);
  assert.ok(!("musicDuckDb" in args));
});
