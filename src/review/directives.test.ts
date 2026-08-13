import test from "node:test";
import assert from "node:assert/strict";
import { Directive } from "./directives.js";

const REASON = "reviewer said the footage does not show the protocol at 6s";

test("generate_visual accepts a diagram scene", () => {
  const parsed = Directive.parse({
    kind: "generate_visual",
    beat_id: "how",
    spec: {
      scene: "diagram",
      nodes: [
        { id: "b", label: "Browser" },
        { id: "s", label: "Server" },
      ],
      edges: [{ from: "b", to: "s", label: "HTML", direction: "both" }],
    },
    reason: REASON,
  });
  assert.equal(parsed.kind, "generate_visual");
  assert.equal(parsed.kind === "generate_visual" && parsed.spec.scene, "diagram");
});

test("generate_visual accepts every scene in the closed set", () => {
  const specs = [
    { scene: "code", language: "python", code: "print(1)" },
    { scene: "terminal", lines: [{ command: "cargo bench" }] },
    {
      scene: "diagram",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b" }],
    },
    { scene: "metric", value: "600", label: "simultaneous readers" },
    {
      scene: "compare",
      left: { title: "REST", items: ["two round trips"] },
      right: { title: "WebSocket", items: ["one open connection"] },
    },
    { scene: "particles", mood: "network" },
  ];
  for (const spec of specs) {
    const parsed = Directive.parse({
      kind: "generate_visual",
      beat_id: "how",
      spec,
      reason: REASON,
    });
    assert.equal(parsed.kind === "generate_visual" && parsed.spec.scene, spec.scene);
  }
});

test("generate_visual rejects a scene name outside the closed set", () => {
  // Free-form scenes are the failure this feature deliberately forecloses:
  // an unknown scene name would render nothing and pass every later check.
  const result = Directive.safeParse({
    kind: "generate_visual",
    beat_id: "how",
    spec: { scene: "animated_infographic", html: "<div/>" },
    reason: REASON,
  });
  assert.equal(result.success, false);
});

test("generate_visual rejects code longer than a phone screen can hold", () => {
  const result = Directive.safeParse({
    kind: "generate_visual",
    beat_id: "how",
    spec: { scene: "code", language: "js", code: "x".repeat(601) },
    reason: REASON,
  });
  assert.equal(result.success, false);
});

test("generate_visual rejects a diagram with only one node", () => {
  const result = Directive.safeParse({
    kind: "generate_visual",
    beat_id: "how",
    spec: {
      scene: "diagram",
      nodes: [{ id: "a", label: "A" }],
      edges: [{ from: "a", to: "a" }],
    },
    reason: REASON,
  });
  assert.equal(result.success, false);
});

test("generate_visual still requires a beat_id and a reason", () => {
  for (const bad of [
    { kind: "generate_visual", spec: { scene: "particles" }, reason: REASON },
    { kind: "generate_visual", beat_id: "how", spec: { scene: "particles" }, reason: "short" },
  ]) {
    assert.equal(Directive.safeParse(bad).success, false);
  }
});

test("replace_visual is unchanged by the new kind", () => {
  const parsed = Directive.parse({
    kind: "replace_visual",
    beat_id: "why",
    stock_query: "developer at laptop night",
    reason: REASON,
  });
  assert.equal(parsed.kind === "replace_visual" && parsed.stock_query, "developer at laptop night");
});
