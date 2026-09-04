import test from "node:test";
import assert from "node:assert/strict";
import { composeHtml, compose, assertSafeRunId } from "./compose.js";
import { config } from "../config.js";
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

/**
 * The composition itself — everything inside the root element. Assertions
 * about how many elements of a kind exist must be scoped to this, not to the
 * whole document: the <head> and the <style> block (which carries prose about
 * `<video data-start>`) are not part of the composition.
 */
function rootHtml(html: string): string {
  const start = html.indexOf("<div id=\"root\"");
  assert.ok(start >= 0, "no root element");
  return html.slice(start, html.lastIndexOf("</div>") + "</div>".length);
}

const VOID_TAGS = new Set(["img", "br", "hr", "source", "meta", "link", "input"]);

/**
 * The open-tag attribute strings of every ancestor of each <video>, keyed by
 * the video's own tag. A real ancestor walk, so the test would actually catch
 * a video wrapped in a timed <section>/<div>.
 */
function videoAncestors(root: string): Array<{ tag: string; ancestors: string[] }> {
  const out: Array<{ tag: string; ancestors: string[] }> = [];
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|[^>])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(root)) !== null) {
    const [full, closing, name, attrs, selfClose] = m;
    const tag = name!.toLowerCase();
    if (closing) {
      stack.pop();
      continue;
    }
    if (tag === "video") out.push({ tag: full!, ancestors: [...stack] });
    if (selfClose || VOID_TAGS.has(tag)) continue;
    stack.push(attrs!);
  }
  return out;
}

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
  const root = rootHtml(composeHtml(base));
  const videoTags = root.match(/<video[^>]*>/g) ?? [];
  assert.equal(videoTags.length, 2);
  for (const tag of videoTags) {
    assert.match(tag, /\smuted/);
    assert.match(tag, /\splaysinline/);
    assert.ok(!/crossorigin/.test(tag), "crossorigin is a hard lint error");
  }
});

test("no video is nested inside another timed element", () => {
  // video_nested_in_timed_element is a lint error and a real render bug: the
  // clip shows the wrong source frames and then vanishes mid-slot.
  const found = videoAncestors(rootHtml(composeHtml(base)));
  assert.equal(found.length, 2);
  for (const { tag, ancestors } of found) {
    for (const attrs of ancestors) {
      assert.ok(!/data-start/.test(attrs), `${tag} nested in a timed element (${attrs})`);
    }
    // Each video carries its own timing instead.
    assert.match(tag, /data-start="/);
  }
});

test("the document loads a pinned GSAP — it is not pre-injected", () => {
  const html = composeHtml(base);
  assert.match(html, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@3\.14\.2\/dist\/gsap\.min\.js"><\/script>/);
  // Loaded before the inline timeline script that calls gsap.timeline().
  assert.ok(html.indexOf("gsap.min.js") < html.indexOf("gsap.timeline("));
});

test("beats are placed back to back in seconds with no gap", () => {
  const html = composeHtml(base);
  assert.match(html, /id="video-hook"[^>]*data-start="0"/);
  assert.match(html, /id="video-body"[^>]*data-start="2\.133333"/);
});

test("the canvas and frame rate come from config, not from a literal", () => {
  const html = composeHtml(base);
  assert.match(html, new RegExp(`data-fps="${config.video.fps}"`));
  assert.match(html, new RegExp(`data-width="${config.video.width}"`));
  assert.match(html, new RegExp(`data-height="${config.video.height}"`));
});

test("the music bed is ducked as linear gain, not decibels", () => {
  const html = composeHtml({ ...base, musicDuckDb: -20 });
  assert.match(html, /id="music"[^>]*data-volume="0\.1"/);
});

test("the music fades target the ducked gain, never 1", () => {
  const html = composeHtml({ ...base, musicDuckDb: -20 });
  // A tween REPLACES the data-volume baseline rather than scaling it.
  assert.match(html, /volume: 0\.1, duration: 0\.5/);
  assert.match(html, /volume: 0, duration: 1\.5.*?\}, 3\.766667\)/);
  assert.ok(!/volume: 1[,\s]/.test(html), "a fade to 1 would undo the duck");
});

test("a manifest with no music still registers exactly one timeline", () => {
  const noMusic = { ...manifest, music: undefined } as unknown as AssetManifest;
  const html = composeHtml({ ...base, manifest: noMusic });
  assert.ok(!/id="music"/.test(html));
  assert.equal(html.match(/gsap\.timeline\(/g)?.length, 1);
  assert.match(html, /window\.__timelines\["kernelshorts"\]/);
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

test("the screen-recording push-in is biased up and left, stock is centred", () => {
  const html = composeHtml(base);
  assert.match(html, /id="video-body"[^>]*object-position: 42% 32%/);
  assert.match(html, /id="video-hook"[^>]*object-position: 50% 50%/);
});

test("a zoom override replaces the default for that beat", () => {
  const html = composeHtml({ ...base, overrides: { beats: { hook: { zoom: 1.8 } } } });
  assert.match(html, /id="video-hook"[^>]*style="[^"]*scale\(1\.8\)/);
});

test("a centerY override moves the vertical focus of the push-in", () => {
  const html = composeHtml({ ...base, overrides: { beats: { body: { centerY: 0.5 } } } });
  assert.match(html, /id="video-body"[^>]*object-position: 42% 50%/);
});

test("splitAt cuts a beat into two shots and pushes the second in", () => {
  const html = composeHtml({ ...base, overrides: { beats: { hook: { splitAt: 0.5 } } } });
  assert.match(html, /id="video-hook-a"/);
  assert.match(html, /id="video-hook-b"/);
  // The second shot is pushed in 1.3x relative to the first.
  assert.match(html, /id="video-hook-b"[^>]*style="[^"]*scale\(1\.3\)/);
});

test("a split shot continues through the cut instead of restarting", () => {
  const html = composeHtml({ ...base, overrides: { beats: { hook: { splitAt: 0.5 } } } });
  // Beat is 64 frames = 2.133333s; the cut is at half of it.
  assert.match(html, /id="video-hook-a"[^>]*data-start="0"[^>]*data-media-start="0"/);
  assert.match(html, /id="video-hook-b"[^>]*data-start="1\.066667"[^>]*data-media-start="1\.066667"/);
});

test("trims shorten the visual without moving the beat boundary", () => {
  const html = composeHtml({
    ...base,
    overrides: { beats: { body: { trimStartFrames: 3, trimEndFrames: 6 } } },
  });
  // Beat is 94 frames = 3.133333s; trimming 9 frames leaves 2.833333s, and
  // the beat still starts where the VO says it does.
  assert.match(html, /id="video-body"[^>]*data-start="2\.133333"/);
  assert.match(html, /id="video-body"[^>]*data-duration="2\.833333"/);
  assert.match(html, /id="video-body"[^>]*data-media-start="0\.1"/);
  // The VO — which owns the boundary — is untouched.
  assert.match(html, /id="vo-body"[^>]*data-start="2\.133333"/);
});

test("an asset shorter than its beat is clamped, not stretched", () => {
  const short = [
    { ...plan[0]!, asset: { ...plan[0]!.asset, durationS: 1 } },
    plan[1]!,
  ];
  const html = composeHtml({ ...base, plan: short });
  assert.match(html, /id="video-hook"[^>]*data-duration="1"/);
  // The beat boundary is unchanged — the next beat still starts on time.
  assert.match(html, /id="video-body"[^>]*data-start="2\.133333"/);
  assert.ok(!/speed/.test(html), "no speed stretch — see the module comment");
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

test("a beat with no title gets no scrim even when its treatment is bare", () => {
  // Beat 1 ("body") cycles to hardShadow but has no on-screen text.
  const html = composeHtml(base);
  assert.ok(!/id="scrim-body"/.test(html));
  const withText = [plan[0]!, { ...plan[1]!, onScreenText: "BODY" }];
  assert.match(composeHtml({ ...base, plan: withText }), /id="scrim-body"/);
});

test("titles render, and the caption track is emitted per beat", () => {
  const html = composeHtml(base);
  assert.match(html, /id="title-hook"[^>]*data-start="0"[^>]*data-duration="2\.133333"/);
  assert.match(html, /id="cap-line-hook-0"/);
  assert.match(html, /id="cap-line-body-0"/);
  // Words come from the script, not from a transcriber.
  assert.match(html, /First/);
  assert.match(html, /Second/);
});

test("captionHighlight is forwarded through to the emitted caption markup", () => {
  const defaultSpan = rootHtml(composeHtml(base)).match(/<span class="caption-word__hl[^"]*"/)?.[0];
  assert.match(defaultSpan ?? "", /caption-word__hl--block/);

  const popSpan = rootHtml(composeHtml({ ...base, captionHighlight: "pop" }))
    .match(/<span class="caption-word__hl[^"]*"/)?.[0];
  assert.match(popSpan ?? "", /caption-word__hl--pop/);
});

test("caption durations carry no float noise", () => {
  const html = composeHtml(base);
  for (const value of html.match(/data-(?:start|duration|media-start|volume)="([^"]+)"/g) ?? []) {
    const n = value.slice(value.indexOf('"') + 1, -1);
    assert.ok(!/\.\d{7,}/.test(n), `unrounded value in the HTML: ${value}`);
  }
});

test("image overlays are placed and sized from the manifest", () => {
  const withOverlay = {
    ...manifest,
    overlays: [{ beat_id: "hook", path: "/o/x.png", width: 600, height: 200, scale: 0.5, centerY: 0.6 }],
  } as unknown as AssetManifest;
  const html = composeHtml({ ...base, manifest: withOverlay });
  assert.match(html, /id="overlay-hook"[^>]*data-start="0"[^>]*data-duration="2\.133333"/);
  assert.match(html, /id="overlay-hook"[^>]*width: 50%/);
  assert.match(html, /id="overlay-hook"[^>]*top: 60%/);
  // .clip is full-bleed; the overlay must release that box before sizing.
  assert.match(html, /id="overlay-hook"[^>]*inset: auto/);
});

test("text from the script is escaped before it reaches the HTML", () => {
  const nasty = [
    { ...plan[0]!, onScreenText: `A & B <script>`, voText: `quote " and <b>` },
    plan[1]!,
  ];
  const html = composeHtml({ ...base, plan: nasty });
  // splitLines may break the title across spans; the escaping is what matters.
  assert.match(html, /&amp;/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!/<script>A/.test(html));
  assert.match(html, /&lt;b&gt;/);
  // Still exactly one real script element per document (the timeline).
  assert.equal(rootHtml(html).match(/<script/g), null);
});

test("an unsafe run id is refused before anything is deleted", async () => {
  for (const runId of ["../evil", "a/b", "   ", ""]) {
    assert.throws(() => assertSafeRunId(runId), /unsafe run id/, `accepted "${runId}"`);
    await assert.rejects(
      compose({ ...base, runId, projectDir: "/tmp/should-never-be-touched" }),
      /unsafe run id/,
    );
  }
  assert.doesNotThrow(() => assertSafeRunId("2026-09-04-run"));
});
