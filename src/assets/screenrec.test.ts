import test from "node:test";
import assert from "node:assert/strict";
import { parseAction, viewportFor } from "./screenrec.js";

test("goto action carries no argument", () => {
  assert.deepEqual(parseAction("goto"), { kind: "goto" });
});

test("click action captures the selector verbatim", () => {
  assert.deepEqual(parseAction("click #demo .btn"), { kind: "click", selector: "#demo .btn" });
});

test("scroll action parses a pixel amount", () => {
  assert.deepEqual(parseAction("scroll 600"), { kind: "scroll", pixels: 600 });
});

test("wait action parses milliseconds", () => {
  assert.deepEqual(parseAction("wait 1500"), { kind: "wait", ms: 1500 });
});

test("hover action captures the selector", () => {
  assert.deepEqual(parseAction("hover .card"), { kind: "hover", selector: ".card" });
});

test("type action splits selector from the text to type", () => {
  assert.deepEqual(parseAction("type input[name=q] hello world"), {
    kind: "type",
    selector: "input[name=q]",
    text: "hello world",
  });
});

test("an unknown action throws rather than being skipped", () => {
  assert.throws(() => parseAction("teleport #x"), /Unknown screenrec action/);
});

test("a scroll without a pixel count throws", () => {
  assert.throws(() => parseAction("scroll"), /scroll/);
});

test("mobile records native vertical 1080x1920", () => {
  assert.deepEqual(viewportFor("mobile"), { width: 1080, height: 1920, isMobile: true });
});

test("desktop records 1920x1080 for crop-and-pan in the edit", () => {
  assert.deepEqual(viewportFor("desktop"), { width: 1920, height: 1080, isMobile: false });
});
