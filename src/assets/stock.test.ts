import test from "node:test";
import assert from "node:assert/strict";
import { pickBest, type StockCandidate } from "./stock.js";

function cand(p: Partial<StockCandidate>): StockCandidate {
  return {
    provider: "pexels",
    id: "1",
    downloadUrl: "https://example.com/a.mp4",
    width: 1080,
    height: 1920,
    durationS: 10,
    pageUrl: "https://example.com/a",
    attribution: "Someone",
    ...p,
  };
}

test("landscape candidates are rejected outright", () => {
  assert.throws(
    () => pickBest([cand({ width: 1920, height: 1080 })], 5),
    /No portrait/,
  );
});

test("candidates below 1080p height are rejected", () => {
  assert.throws(() => pickBest([cand({ width: 540, height: 960 })], 5), /No portrait/);
});

test("a clip shorter than the beat needs loses to one long enough", () => {
  const short = cand({ id: "short", durationS: 3 });
  const long = cand({ id: "long", durationS: 9 });
  assert.equal(pickBest([short, long], 6).id, "long");
});

test("among long-enough clips the higher resolution wins", () => {
  const hd = cand({ id: "hd", width: 1080, height: 1920 });
  const uhd = cand({ id: "uhd", width: 2160, height: 3840 });
  assert.equal(pickBest([hd, uhd], 4).id, "uhd");
});

test("among long-enough equal-resolution clips the tighter duration fit wins", () => {
  const loose = cand({ id: "loose", durationS: 60 });
  const tight = cand({ id: "tight", durationS: 8 });
  assert.equal(pickBest([loose, tight], 6).id, "tight");
});

test("the winning provider is preserved on the chosen candidate", () => {
  const chosen = pickBest([cand({ provider: "pixabay", id: "pb" })], 4);
  assert.equal(chosen.provider, "pixabay");
});

test("a stock clip at a non-project fps is conformed to the project fps", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const exec = promisify(execFile);
  const { conformToProjectFps } = await import("./stock.js");
  const { probeMedia } = await import("./ffprobe.js");

  const dir = await mkdtemp(join(tmpdir(), "fps-"));
  const src = join(dir, "src25.mp4");
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=25:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", src,
  ]);
  assert.equal((await probeMedia(src)).fps, 25);

  const out = await conformToProjectFps(src);
  assert.equal((await probeMedia(out)).fps, 30);
});
