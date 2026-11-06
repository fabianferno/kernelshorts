import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAssets } from "./acquire.js";
import { closeDb } from "../db/mongo.js";
import type { ScriptJSON } from "../shared/schemas.js";

const exec = promisify(execFile);

/** A real PNG on disk, made by real ffmpeg — not a fixture stand-in for one. */
async function realPng(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=navy:s=1080x1920", "-frames:v", "1", path,
  ]);
  return path;
}

function script(beats: ScriptJSON["beats"]): ScriptJSON {
  return {
    run_id: "acquire-test",
    topic: { title: "t", url: "https://example.com" },
    target_duration_s: 30,
    music_mood: "upbeat-tech",
    beats,
    claims: [],
    cta: { vo_text: "follow", on_screen_text: "Follow" },
  };
}

test("photo beats become framed Ken Burns clips with measured dimensions", async () => {
  const ws = await mkdtemp(join(tmpdir(), "acq-"));
  await mkdir(join(ws, "assets"), { recursive: true });
  const a = await realPng(ws, "a.png");
  const b = await realPng(ws, "b.png");

  const manifest = await acquireAssets(
    script([
      { id: "hook", vo_text: "one", visual: { type: "still", source: a, kenBurns: true }, max_duration_s: 4 },
      { id: "body", vo_text: "two", visual: { type: "still", source: b, kenBurns: false }, max_duration_s: 5 },
    ]),
    ws,
    { music: false },
  );

  assert.equal(manifest.assets.length, 2);
  assert.deepEqual(manifest.assets.map((x) => x.beat_id), ["hook", "body"]);
  // photos become videos framed for their fit: card (default) 1080x960
  assert.equal(manifest.assets[0]?.width, 1080);
  assert.equal(manifest.assets[0]?.height, 960);
  assert.equal(manifest.assets[0]?.fit, "card");
  assert.match(manifest.assets[0]!.path, /\.mp4$/);
  assert.ok((manifest.assets[0]?.durationS ?? 0) >= 1, "the photo clip has a real duration");
});

test("one failed beat fails the whole manifest and the error names the beat", async () => {
  const ws = await mkdtemp(join(tmpdir(), "acq-"));
  await mkdir(join(ws, "assets"), { recursive: true });
  const a = await realPng(ws, "a.png");

  await assert.rejects(
    acquireAssets(
      script([
        { id: "hook", vo_text: "one", visual: { type: "still", source: a, kenBurns: true }, max_duration_s: 4 },
        {
          id: "broken",
          vo_text: "two",
          visual: { type: "still", source: join(ws, "does-not-exist.png"), kenBurns: false },
          max_duration_s: 5,
        },
      ]),
      ws,
      { music: false },
    ),
    /broken/,
  );
});

test.after(async () => {
  await closeDb();
});
