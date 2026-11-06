import test from "node:test";
import assert from "node:assert/strict";
import { composeHtml, compose, assertSafeRunId, uncoveredIntervals } from "./compose.js";
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

/** The same hook beat as a full-bleed generated scene (where zoom applies). */
const generatedHook: BeatPlan = {
  ...plan[0]!,
  asset: { ...plan[0]!.asset, kind: "generated" } as never,
};

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

test("footage is framed as a card and never pushed in; a generated scene is full-bleed", () => {
  const html = composeHtml({ ...base, plan: [generatedHook, plan[1]!] });
  // screen recording → card, no zoom (a zoomed card crops its own content)
  assert.match(html, /class="beat-video clip stage-card" id="video-body"/);
  assert.ok(!/id="video-body"[^>]*scale\(/.test(html));
  // generated → full-bleed, carries its framing transform
  assert.match(html, /class="beat-video clip" id="video-hook"[^>]*style="transform: scale\(1\)/);
});

test("the screen-recording push-in is biased up and left, stock is centred", () => {
  const html = composeHtml(base);
  assert.match(html, /id="video-body"[^>]*object-position: 42% 32%/);
  assert.match(html, /id="video-hook"[^>]*object-position: 50% 50%/);
});

test("a zoom override applies to a generated scene and is ignored on a card", () => {
  const html = composeHtml({ ...base, plan: [generatedHook, plan[1]!], overrides: { beats: { hook: { zoom: 1.8 }, body: { zoom: 1.8 } } } });
  assert.match(html, /id="video-hook"[^>]*style="[^"]*scale\(1\.8\)/);
  assert.ok(!/id="video-body"[^>]*scale\(/.test(html));
});

test("a centerY override moves the vertical focus of the push-in", () => {
  const html = composeHtml({ ...base, overrides: { beats: { body: { centerY: 0.5 } } } });
  assert.match(html, /id="video-body"[^>]*object-position: 42% 50%/);
});

test("splitAt cuts a beat into two shots; only a generated scene pushes the second in", () => {
  const gen = composeHtml({ ...base, plan: [generatedHook, plan[1]!], overrides: { beats: { hook: { splitAt: 0.5 } } } });
  assert.match(gen, /id="video-hook-a"/);
  assert.match(gen, /id="video-hook-b"[^>]*style="[^"]*scale\(1\.3\)/);
  const card = composeHtml({ ...base, overrides: { beats: { hook: { splitAt: 0.5 } } } });
  assert.match(card, /id="video-hook-a"/);
  assert.match(card, /id="video-hook-b"/);
  assert.ok(!/id="video-hook-b"[^>]*scale\(/.test(card));
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

/**
 * THE TASK 8 REGRESSION. Clamping a short asset used to leave the rest of the
 * beat showing #root's black background with the title and caption floating on
 * nothing — 4.6s of it in run 2026-08-18. Every beat must be covered edge to
 * edge by a shot or a held still.
 */
test("a beat whose asset is shorter than its window leaves no uncovered interval", () => {
  const short = [
    { ...plan[0]!, asset: { ...plan[0]!.asset, durationS: 1 } },
    plan[1]!,
  ];
  for (const p of short) {
    assert.deepEqual(
      uncoveredIntervals(p),
      [],
      `beat "${p.beatId}" has an interval no shot and no hold covers`,
    );
  }
});

test("the uncovered remainder of a short beat is a held still of its last frame", () => {
  const short = [
    { ...plan[0]!, asset: { ...plan[0]!.asset, durationS: 1 } },
    plan[1]!,
  ];
  const html = rootHtml(composeHtml({ ...base, plan: short }));
  // Beat is 64 frames = 2.133333s; the asset covers 1s, so 1.133333s is held.
  assert.match(html, /<img[^>]*id="hold-hook-0"[^>]*data-start="1"/);
  assert.match(html, /<img[^>]*id="hold-hook-0"[^>]*data-duration="1\.133333"/);
  assert.match(html, /<img[^>]*id="hold-hook-0"[^>]*src="assets\/holds\/hold-hook-0\.png"/);
  // The hold continues the shot's framing, so the picture stops, not jumps.
  const hold = html.match(/<img[^>]*id="hold-hook-0"[^>]*>/)![0];
  const shot = html.match(/<video[^>]*id="video-hook"[^>]*>/)![0];
  const framing = (s: string): string => s.match(/style="([^"]*)"/)![1]!;
  assert.equal(framing(hold), framing(shot));
});

test("a beat whose asset covers it fully is held nowhere", () => {
  const html = rootHtml(composeHtml(base));
  assert.ok(!/id="hold-/.test(html), "nothing to hold when the asset outlasts the beat");
});

test("a head trim on a split beat is covered rather than left as a gap", () => {
  // The mid-beat gap that deferred item (a) described: shot A shortens by the
  // trim while shot B's placement stays derived from the beat's frames.
  const p = { ...plan[0]!, asset: { ...plan[0]!.asset, durationS: 10 } };
  const overrides = { beats: { hook: { splitAt: 0.5, trimStartFrames: 6 } } };
  assert.deepEqual(uncoveredIntervals(p, overrides), []);
});

/**
 * A tail hold after a split beat must continue shot B's framing, not
 * ordered[0] (shot A's). Shot B carries its own zoom (SPLIT_PUSH_IN, 1.3x
 * shot A's), so a hold that freezes at shot A's framing instead is a visible
 * scale pop — the picture jumps back to a wider shot before it freezes,
 * contradicting "the picture stops rather than jumps".
 */
test("a tail hold after a split beat continues shot B's framing, not shot A's", () => {
  const p = { ...generatedHook, asset: { ...generatedHook.asset, durationS: 10 } };
  const overrides = { beats: { hook: { splitAt: 0.5, trimEndFrames: 6 } } };
  const html = rootHtml(composeHtml({ ...base, plan: [p], overrides }));
  const framing = (s: string): string => s.match(/style="([^"]*)"/)![1]!;
  const shotB = html.match(/<video[^>]*id="video-hook-b"[^>]*>/)![0];
  const hold = html.match(/<img[^>]*id="hold-hook-\d+"[^>]*>/)![0];
  assert.equal(framing(hold), framing(shotB));
  assert.notEqual(framing(hold), framing(html.match(/<video[^>]*id="video-hook-a"[^>]*>/)![0]));
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
  const nasty = [{ ...plan[0]!, voText: `quote " and <b> & <script>` }, plan[1]!];
  const html = composeHtml({ ...base, plan: nasty });
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;/);
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /&lt;script&gt;/);
  // Still exactly one real script element per document (the timeline), none in the root.
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

test("a user photo/clip honours its fit: full fills the frame, card is framed", () => {
  const full = { ...plan[0]!, asset: { ...plan[0]!.asset, kind: "clip", fit: "full" } as never };
  const card = { ...plan[1]!, asset: { ...plan[1]!.asset, kind: "still", fit: "card" } as never };
  const html = composeHtml({ ...base, plan: [full, card] });
  assert.match(html, /class="beat-video clip" id="video-hook"/);
  assert.match(html, /class="beat-video clip stage-card" id="video-body"/);
});

test("each beat's visual enters with a bloop, cycling the variants, under the voice", () => {
  const html = rootHtml(composeHtml({ ...base, sfx: ["/s/b0.wav", "/s/b1.wav", "/s/b2.wav"] }));
  const tags = html.match(/<audio id="sfx-[^>]*>/g) ?? [];
  assert.equal(tags.length, plan.length);
  // beat 2 starts at frame 64 → 2.133333s, +0.05s offset
  assert.match(tags[1]!, /data-start="2\.183333"/);
  assert.match(tags[1]!, /src="assets\/sfx\/bloop-1\.wav"/);
  for (const t of tags) assert.match(t, /data-volume="0\.45"/);
});

test("no sfx given → no sfx tracks", () => {
  assert.doesNotMatch(composeHtml(base), /id="sfx-/);
});
