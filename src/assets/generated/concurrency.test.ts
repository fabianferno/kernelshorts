import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeneratedScene } from "../../shared/schemas.js";
import { renderScene } from "./index.js";
import { config } from "../../config.js";

/**
 * The one defect that only reproduces under contention.
 *
 * Playwright's recorder runs on WALL CLOCK, so the frames it captures after
 * __start() depend on how much CPU the page actually gets. Rendering one scene
 * at a time this was never visible; acquireAssets renders at concurrency 3, and
 * with three Chromium instances competing for the compositor the metric scene
 * came back 3.200s against a 3.584s beat. The clip was correct in every other
 * way — right size, right fps, not black, frames differing — so every existing
 * check passed it, and a beat-length hole landed in the timeline.
 *
 * renderScene now retries a SHORT recording once with a 6x tail. This asserts
 * that contract holds at the concurrency the pipeline actually uses.
 *
 * This is the only test in the suite that records and encodes real video: three
 * Chromium recordings plus three H.264 passes, measured at ~8s wall clock and
 * ~900% CPU on this M-series Mac. That is tolerable today; see the note at the
 * bottom of the file for how to gate it if it grows.
 */

/** One frame. The trim is cut to `durationS` at this fps, so a correct clip
 *  lands within a frame either way; anything more is a dropped beat. */
const TOLERANCE_S = 1 / config.video.fps;

/** 3.584s is the real beat length from the run that first exposed this. */
const BEAT_S = 3.584;

test(
  "three scenes rendered at once each come back at the requested length",
  { timeout: 600_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "genscene-concurrency-"));
    try {
      const specs = [
        // The metric scene is first because it is the one that came back short.
        { scene: "metric", value: "600", label: "simultaneous readers" },
        {
          scene: "terminal",
          lines: [{ command: "npm run bench", output: "12,400 req/s" }],
        },
        {
          scene: "diagram",
          nodes: [
            { id: "b", label: "Browser" },
            { id: "s", label: "Server" },
          ],
          edges: [{ from: "b", to: "s", direction: "both", label: "HTML" }],
        },
      ];

      const started = Date.now();
      const results = await Promise.all(
        specs.map((raw, i) =>
          renderScene({
            spec: GeneratedScene.parse(raw),
            durationS: BEAT_S,
            outPath: join(dir, `scene-${i}.mp4`),
          }),
        ),
      );
      const wall = (Date.now() - started) / 1000;

      for (const [i, r] of results.entries()) {
        const delta = r.durationS - BEAT_S;
        assert.ok(
          Math.abs(delta) <= TOLERANCE_S,
          `${specs[i]!.scene} came back ${r.durationS.toFixed(3)}s against a ` +
            `${BEAT_S.toFixed(3)}s beat (${delta >= 0 ? "+" : ""}${delta.toFixed(3)}s, ` +
            `tolerance ${TOLERANCE_S.toFixed(3)}s = one frame). Under render ` +
            `contention the recorder stopped early and a beat-length hole ` +
            `reaches the timeline.`,
        );
        assert.equal(r.width, config.video.width);
        assert.equal(r.height, config.video.height);
      }

      // Recorded so a future regression in render throughput is visible rather
      // than just felt as a slow suite.
      console.log(
        `3 concurrent scene renders in ${wall.toFixed(1)}s; durations ` +
          results.map((r) => r.durationS.toFixed(3)).join(", "),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

/**
 * GATING, if that changes: this file is the only test that
 * needs ffmpeg and a video encode, so it is already separable by path —
 * `tsx --test src/**\/*.test.ts --test-skip-pattern=concurrency` for the inner
 * loop, everything for CI. Splitting it out by name rather than by an env flag
 * keeps it from being a test that quietly never runs.
 */
