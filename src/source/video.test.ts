import test from "node:test";
import assert from "node:assert/strict";
import { isVideoUrl } from "./video.js";

test("reel / short / tiktok links are video sources; articles and channels are not", () => {
  for (const u of [
    "https://www.instagram.com/p/DfWH4QfhEvs/",
    "https://www.instagram.com/reel/abc123/",
    "https://www.youtube.com/shorts/xyz",
    "https://www.youtube.com/watch?v=xyz",
    "https://youtu.be/xyz",
    "https://www.tiktok.com/@user/video/123",
  ]) assert.ok(isVideoUrl(u), u);
  for (const u of [
    "https://news.ycombinator.com/item?id=1",
    "https://www.youtube.com/@somechannel",
    "https://example.com/post",
    "not a url",
  ]) assert.ok(!isVideoUrl(u), u);
});
