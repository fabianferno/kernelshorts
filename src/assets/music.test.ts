import test from "node:test";
import assert from "node:assert/strict";
import { selectTrack, type MusicTrack } from "./music.js";

function track(p: Partial<MusicTrack>): MusicTrack {
  return {
    id: "music/x.mp3",
    name: "x",
    path: "/vault/music/x.mp3",
    durationS: 120,
    mood: ["upbeat-tech"],
    licenseStatus: "ok",
    ...p,
  };
}

test("a track whose mood matches and is long enough is chosen and flagged matched", () => {
  const r = selectTrack([track({ id: "a" })], "upbeat-tech", 50);
  assert.equal(r.track.id, "a");
  assert.equal(r.matchedMood, true);
});

test("a track with licenseStatus missing is never selectable", () => {
  assert.throws(
    () => selectTrack([track({ licenseStatus: "missing" })], "upbeat-tech", 50),
    /licensed/,
  );
});

test("mood matching ignores case", () => {
  const r = selectTrack([track({ mood: ["Upbeat-Tech"] })], "upbeat-tech", 30);
  assert.equal(r.matchedMood, true);
});

test("a mood-matching track that is too short is skipped for a longer one", () => {
  const r = selectTrack(
    [track({ id: "short", durationS: 20 }), track({ id: "long", durationS: 90 })],
    "upbeat-tech",
    60,
  );
  assert.equal(r.track.id, "long");
});

test("with no mood match it falls back to a licensed track and says matchedMood false", () => {
  const r = selectTrack([track({ id: "chill", mood: ["chill"] })], "upbeat-tech", 40);
  assert.equal(r.track.id, "chill");
  assert.equal(r.matchedMood, false);
});

test("the fallback still refuses unlicensed tracks", () => {
  assert.throws(
    () => selectTrack([track({ mood: ["chill"], licenseStatus: "missing" })], "upbeat-tech", 40),
    /licensed/,
  );
});

test("an empty catalog is a hard error, not a silent no-music short", () => {
  assert.throws(() => selectTrack([], "upbeat-tech", 40), /licensed/);
});
