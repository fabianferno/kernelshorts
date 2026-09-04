import test from "node:test";
import assert from "node:assert/strict";
import { checkpointPathFor, wordTimingsForBeat } from "./build.js";

test("a checkpoint is a directory copy, not a binary package", () => {
  const p = checkpointPathFor("/runs/x/checkpoints", "run-1", 2);
  assert.ok(!p.endsWith(".palmier"));
  assert.match(p, /run-1-v2$/);
});

test("wordTimingsForBeat returns the transcriber's timings when they exist", async () => {
  const logs: string[] = [];
  const timings = await wordTimingsForBeat(
    "hook",
    "/vo/hook.mp3",
    (m) => logs.push(m),
    async () => [{ word: "hi", startS: 0, endS: 0.3 }],
  );
  assert.deepEqual(timings, [{ word: "hi", startS: 0, endS: 0.3 }]);
  assert.equal(logs.length, 0);
});

test("wordTimingsForBeat logs loudly and falls back to empty on no words", async () => {
  const logs: string[] = [];
  const timings = await wordTimingsForBeat(
    "hook",
    "/vo/hook.mp3",
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
