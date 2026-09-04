import test from "node:test";
import assert from "node:assert/strict";
import { composeHtml } from "./compose.js";
import type { BeatPlan } from "./plan-beats.js";
import type { AssetManifest } from "../shared/schemas.js";

const plan: BeatPlan[] = [
  {
    beatId: "hook", startFrame: 0, endFrame: 64,
    voPath: "/vo/hook.wav", voDurationS: 2, voText: "First line here.",
    asset: { beat_id: "hook", path: "/v/a.mp4", kind: "stock", width: 1280, height: 720, durationS: 10 } as never,
    onScreenText: "HOOK",
  },
  {
    beatId: "body", startFrame: 64, endFrame: 158,
    voPath: "/vo/body.wav", voDurationS: 3, voText: "Second line here.",
    asset: { beat_id: "body", path: "/v/b.mp4", kind: "screenrec", width: 1280, height: 720, durationS: 10 } as never,
    onScreenText: undefined,
  },
];

const manifest = { voiceover: [], assets: [], overlays: [], music: { name: "bed", path: "/m/bed.mp3" } } as unknown as AssetManifest;

const base = { plan, manifest, projectDir: "/tmp/p", runId: "test-run" };

test("the root declares the project canvas and a duration in seconds", () => {
  const html = composeHtml(base);
  assert.match(html, /data-composition-id="kernelshorts"/);
  assert.match(html, /data-width="1080"/);
  assert.match(html, /data-height="1920"/);
  // 158 frames at 30fps = 5.266667s
  assert.match(html, /data-duration="5\.266667"/);
});

test("exactly one paused GSAP timeline is registered under the composition id", () => {
  const html = composeHtml(base);
  assert.equal(html.match(/gsap\.timeline\(/g)?.length, 1);
  assert.match(html, /paused:\s*true/);
  assert.match(html, /window\.__timelines\["kernelshorts"\]/);
});

test("every audio element has an id — an id-less one renders silent", () => {
  const html = composeHtml(base);
  const audioTags = html.match(/<audio[^>]*>/g) ?? [];
  assert.ok(audioTags.length >= 3, "expected two VO tracks and a music bed");
  for (const tag of audioTags) assert.match(tag, /\sid="/, `audio without id: ${tag}`);
});

test("videos are muted and inline, and carry no crossorigin", () => {
  const html = composeHtml(base);
  const videoTags = html.match(/<video[^>]*>/g) ?? [];
  assert.equal(videoTags.length, 2);
  for (const tag of videoTags) {
    assert.match(tag, /\smuted/);
    assert.match(tag, /\splaysinline/);
    assert.ok(!/crossorigin/.test(tag), "crossorigin is a hard lint error");
  }
});

test("no video is nested inside another timed element", () => {
  // video_nested_in_timed_element is a lint error and a real render bug.
  const html = composeHtml(base);
  // Each <video> must carry its own data-start and not sit inside a
  // <section data-start> wrapper. Assert videos are direct root children.
  const rootBody = html.slice(html.indexOf('data-composition-id="kernelshorts"'));
  assert.ok(!/<section[^>]*data-start[^>]*>\s*<video/.test(rootBody));
});

test("beats are placed back to back in seconds with no gap", () => {
  const html = composeHtml(base);
  assert.match(html, /id="video-hook"[^>]*data-start="0"/);
  assert.match(html, /id="video-body"[^>]*data-start="2\.133333"/);
});

test("the music bed is ducked as linear gain, not decibels", () => {
  const html = composeHtml({ ...base, musicDuckDb: -20 });
  assert.match(html, /id="music"[^>]*data-volume="0\.1"/);
});

test("each beat's own source audio is muted so the VO carries the sound", () => {
  const html = composeHtml(base);
  // No <audio> is emitted for the visual sources at all — the <video> is muted.
  assert.ok(!/id="video-hook-audio"/.test(html));
});

test("a screen recording gets the tuned push-in; stock footage does not", () => {
  const html = composeHtml(base);
  assert.match(html, /id="video-body"[^>]*style="[^"]*scale\(2\.4\)/);
  assert.ok(!/id="video-hook"[^>]*scale\(2\.4\)/.test(html));
});

test("a zoom override replaces the default for that beat", () => {
  const html = composeHtml({ ...base, overrides: { beats: { hook: { zoom: 1.8 } } } });
  assert.match(html, /id="video-hook"[^>]*style="[^"]*scale\(1\.8\)/);
});

test("splitAt cuts a beat into two shots and pushes the second in", () => {
  const html = composeHtml({ ...base, overrides: { beats: { hook: { splitAt: 0.5 } } } });
  assert.match(html, /id="video-hook-a"/);
  assert.match(html, /id="video-hook-b"/);
  // The second shot is pushed in 1.3x relative to the first.
  assert.match(html, /id="video-hook-b"[^>]*style="[^"]*scale\(1\.3\)/);
});

test("a treatment of none drops the title and its scrim together", () => {
  const html = composeHtml({ ...base, overrides: { beats: { hook: { treatment: "none" } } } });
  assert.ok(!/id="title-hook"/.test(html));
  assert.ok(!/id="scrim-hook"/.test(html));
});

test("the scrim is a gradient div, not an imported PNG", () => {
  const html = composeHtml(base);
  assert.ok(!/scrim\.png/.test(html));
});
