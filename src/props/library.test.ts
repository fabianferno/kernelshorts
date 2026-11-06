import test from "node:test";
import assert from "node:assert/strict";
import { PROPS, getProp } from "./library.js";
import { KIT_JS } from "./kit.js";
import { mouthFromLoudness } from "../edit/envelope.js";
import { placePose, HOST_BOX } from "../edit/studio.js";
import { truncatePlan } from "../edit/compose.js";
import type { BeatPlan } from "../edit/plan-beats.js";

test("every prop and the kit are syntactically valid JS defining build()", () => {
  new Function("THREE", "document", KIT_JS + "\nreturn K;");
  for (const p of PROPS) {
    const f = new Function(`${p.code}\nreturn typeof build;`);
    assert.equal(f(), "function", `${p.id} does not define build()`);
  }
});

test("prop ids are unique and lookup fails loudly", () => {
  assert.equal(new Set(PROPS.map((p) => p.id)).size, PROPS.length);
  assert.throws(() => getProp("nope"), /unknown prop "nope"/);
});

test("mouth: opens on loud frames, closes in silence, never flickers", () => {
  const fps = 30;
  // 0.5 s silence, 1 s speech with dips, 0.5 s silence
  const db = [
    ...Array(15).fill(-80),
    ...Array.from({ length: 30 }, (_, i) => (i % 6 < 4 ? -18 : -40)),
    ...Array(15).fill(-80),
  ];
  const iv = mouthFromLoudness(db, fps);
  assert.ok(iv.length >= 3, `expected syllable-rate flaps, got ${iv.length}`);
  for (const m of iv) {
    assert.ok(m.startS >= 0.45 && m.endS <= 1.55, `open outside speech: ${m.startS}-${m.endS}`);
    assert.ok(m.endS - m.startS >= 2 / fps - 1e-9, "flap shorter than 2 frames");
  }
  assert.deepEqual(mouthFromLoudness(Array(30).fill(-80), fps), []);
});

test("pose placement: head size normalised, bottom-anchored, mouth centred", () => {
  const small = placePose({ width: 896, height: 1200, headTop: 100, mouth: { x: 450, y: 400, w: 100, h: 45 } });
  const big = placePose({ width: 896, height: 1200, headTop: 80, mouth: { x: 480, y: 480, w: 110, h: 45 } });
  // bottom-anchored: image bottom == box bottom
  for (const p of [small, big]) {
    const h = (p.width / 896) * 1200;
    assert.ok(Math.abs(p.top + h - HOST_BOX.h) < 0.5);
  }
  // mouth lands on the box's horizontal centre
  assert.ok(Math.abs(small.left + 450 * (small.width / 896) - HOST_BOX.w / 2) < 0.5);
  // the bigger-headed pose is drawn smaller
  assert.ok(big.width < small.width);
  assert.match(small.mask, /radial-gradient\(ellipse/);
});

test("truncatePlan drops beats after the cut and clamps the straddler", () => {
  const beat = (id: string, s: number, e: number): BeatPlan =>
    ({ beatId: id, startFrame: s, endFrame: e, voPath: "", voDurationS: (e - s) / 30, voText: "x", asset: {} as never });
  const plan = [beat("a", 0, 150), beat("b", 150, 450), beat("c", 450, 600)];
  const cut = truncatePlan(plan, 10);
  assert.deepEqual(cut.map((b) => b.beatId), ["a", "b"]);
  assert.equal(cut[1]!.endFrame, 300);
  assert.ok(cut[1]!.voDurationS <= 5 + 1e-9);
  assert.equal(truncatePlan(plan, undefined), plan);
});
