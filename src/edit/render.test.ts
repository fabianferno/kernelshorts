import test from "node:test";
import assert from "node:assert/strict";
import { renderArgs } from "./render.js";

test("the render command pins output, fps and strictness", () => {
  const args = renderArgs({ projectDir: "/tmp/p", outputPath: "/tmp/out.mp4" });
  assert.deepEqual(args.slice(0, 2), ["hyperframes", "render"]);
  assert.ok(args.includes("/tmp/p"));
  assert.ok(args.includes("--output"));
  assert.ok(args.includes("/tmp/out.mp4"));
  // 30fps to match config.video.fps.
  assert.equal(args[args.indexOf("--fps") + 1], "30");
  // A lint error silently disables the layout and contrast audits, so never
  // let a render proceed past one.
  assert.ok(args.includes("--strict"));
});

test("quality defaults to high and is overridable for review iterations", () => {
  const qualityOf = (args: string[]) => args[args.indexOf("--quality") + 1];
  assert.equal(qualityOf(renderArgs({ projectDir: "/p", outputPath: "/o.mp4" })), "high");
  assert.equal(
    qualityOf(renderArgs({ projectDir: "/p", outputPath: "/o.mp4", quality: "draft" })),
    "draft",
  );
});

test("no --resolution flag is passed", () => {
  // --resolution only SUPERSAMPLES by an integer factor; it cannot render
  // smaller. Review iterations use --quality draft instead.
  assert.ok(!renderArgs({ projectDir: "/p", outputPath: "/o.mp4" }).includes("--resolution"));
});
