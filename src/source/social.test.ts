import test from "node:test";
import assert from "node:assert/strict";
import { parseTweetUrl, isRedditUrl, parseGitHubRepo } from "./social.js";
import { isVideoUrl } from "./video.js";

test("X / Twitter post links parse; profiles and other sites don't", () => {
  assert.deepEqual(parseTweetUrl("https://x.com/jack/status/20"), { user: "jack", id: "20" });
  assert.deepEqual(parseTweetUrl("https://twitter.com/jack/status/20?s=46"), { user: "jack", id: "20" });
  assert.equal(parseTweetUrl("https://x.com/jack"), undefined);
  assert.equal(parseTweetUrl("https://example.com/jack/status/20"), undefined);
});

test("Reddit threads and GitHub repos are recognised precisely", () => {
  assert.ok(isRedditUrl("https://www.reddit.com/r/programming/comments/abc/title/"));
  assert.ok(!isRedditUrl("https://www.reddit.com/r/programming/"));
  assert.deepEqual(parseGitHubRepo("https://github.com/heygen-com/hyperframes"), { owner: "heygen-com", repo: "hyperframes" });
  assert.deepEqual(parseGitHubRepo("https://github.com/a/b/tree/main/src"), { owner: "a", repo: "b" });
  assert.equal(parseGitHubRepo("https://github.com/a/b/issues/3"), undefined);
});

test("a tweet link is routed to the X handler before the video handler", () => {
  // both match; source.ts checks parseTweetUrl first so text posts aren't sent to yt-dlp
  assert.ok(parseTweetUrl("https://x.com/a/status/1") && isVideoUrl("https://x.com/a/status/1"));
});
