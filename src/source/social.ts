/**
 * Social / platform sources that a plain HTML fetch can't read well.
 *
 *   X / Twitter  api.fxtwitter.com (public, no auth): text, author, quote,
 *                media, stats — x.com pages are JS-only.
 *   Reddit       <post>.json: the post plus the top of the comment tree.
 *   GitHub repo  api.github.com README (raw).
 */
const UA = "kernelshorts-source/1.0";

export function parseTweetUrl(input: string): { user: string; id: string } | undefined {
  try {
    const u = new URL(input);
    if (!/(^|\.)(x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com)$/i.test(u.hostname)) return undefined;
    const m = u.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/);
    return m ? { user: m[1]!, id: m[2]! } : undefined;
  } catch {
    return undefined;
  }
}

interface FxTweet {
  url?: string;
  text?: string;
  created_at?: string;
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number;
  author?: { name?: string; screen_name?: string };
  quote?: FxTweet;
  media?: { videos?: Array<{ url?: string }>; photos?: Array<{ url?: string }> };
  article?: { title?: string; preview_text?: string };
  community_note?: { text?: string } | null;
}

export interface TweetSource {
  title: string;
  handle: string;
  markdown: string;
  hasVideo: boolean;
}

export async function fetchTweet(id: string): Promise<TweetSource> {
  const res = await fetch(`https://api.fxtwitter.com/status/${id}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`fxtwitter ${id} → ${res.status}`);
  const { tweet } = (await res.json()) as { tweet?: FxTweet };
  if (!tweet) throw new Error(`fxtwitter returned no tweet for ${id}`);
  const handle = `@${tweet.author?.screen_name ?? "unknown"}`;
  const lines = [
    `# ${(tweet.article?.title ?? tweet.text ?? "").split("\n")[0]!.slice(0, 110) || `Post by ${handle}`}`,
    `X post: ${tweet.url ?? `https://x.com/i/status/${id}`}`,
    `Author: ${tweet.author?.name ?? ""} (${handle}) · ${tweet.created_at ?? ""}`,
    `Stats: ${tweet.likes ?? 0} likes · ${tweet.retweets ?? 0} reposts · ${tweet.replies ?? 0} replies${tweet.views ? ` · ${tweet.views} views` : ""}`,
    "",
    "## Post",
    "",
    tweet.text ?? "",
  ];
  if (tweet.article) lines.push("", "## Article (X long-form)", "", tweet.article.title ?? "", tweet.article.preview_text ?? "");
  if (tweet.quote) {
    lines.push("", `## Quoted post (@${tweet.quote.author?.screen_name ?? "?"})`, "", tweet.quote.text ?? "");
  }
  if (tweet.community_note?.text) lines.push("", "## Community note", "", tweet.community_note.text);
  const photos = tweet.media?.photos?.map((p) => p.url).filter(Boolean) ?? [];
  if (photos.length) lines.push("", "## Images", "", ...photos.map((p) => `- ${p}`));
  return {
    title: lines[0]!.slice(2),
    handle,
    markdown: lines.join("\n"),
    hasVideo: (tweet.media?.videos?.length ?? 0) > 0,
  };
}

export function isRedditUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return /(^|\.)reddit\.com$/i.test(u.hostname) && /\/comments\//.test(u.pathname);
  } catch {
    return false;
  }
}

interface RedditThing {
  data: { title?: string; selftext?: string; author?: string; score?: number; url?: string; body?: string; subreddit?: string; replies?: { data?: { children?: RedditThing[] } } };
  kind: string;
}

export async function fetchReddit(url: string): Promise<{ title: string; handle: string; markdown: string }> {
  const u = new URL(url);
  u.search = "";
  const res = await fetch(`${u.toString().replace(/\/$/, "")}.json?limit=40&depth=2`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`reddit ${url} → ${res.status}`);
  const [post, comments] = (await res.json()) as [{ data: { children: RedditThing[] } }, { data: { children: RedditThing[] } }];
  const p = post.data.children[0]!.data;
  const lines = [
    `# ${p.title ?? "Reddit post"}`,
    `Reddit: ${url}`,
    `r/${p.subreddit} · u/${p.author} · ${p.score} points`,
    p.url && !p.url.includes("reddit.com") ? `Linked: ${p.url}` : "",
    "",
    "## Post",
    "",
    p.selftext || "(link post — no body)",
    "",
    "## Top comments",
    "",
  ];
  for (const c of comments.data.children.filter((c) => c.kind === "t1").slice(0, 25)) {
    lines.push(`- **u/${c.data.author}** (${c.data.score}): ${(c.data.body ?? "").replace(/\n+/g, " ").slice(0, 600)}`);
    for (const r of (c.data.replies?.data?.children ?? []).filter((r) => r.kind === "t1").slice(0, 2)) {
      lines.push(`  - **u/${r.data.author}** (${r.data.score}): ${(r.data.body ?? "").replace(/\n+/g, " ").slice(0, 400)}`);
    }
  }
  return { title: p.title ?? "reddit", handle: `u/${p.author}`, markdown: lines.filter((l) => l !== undefined).join("\n") };
}

export function parseGitHubRepo(input: string): { owner: string; repo: string } | undefined {
  try {
    const u = new URL(input);
    if (u.hostname !== "github.com") return undefined;
    const [owner, repo, ...rest] = u.pathname.split("/").filter(Boolean);
    // repo root or tree view only — issues/PRs/blobs are ordinary pages
    if (!owner || !repo || (rest.length > 0 && rest[0] !== "tree")) return undefined;
    return { owner, repo: repo.replace(/\.git$/, "") };
  } catch {
    return undefined;
  }
}

export async function fetchGitHubReadme(owner: string, repo: string): Promise<{ title: string; markdown: string }> {
  const meta = (await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { "User-Agent": UA } }).then((r) => r.json())) as {
    description?: string; stargazers_count?: number; language?: string; html_url?: string;
  };
  const readme = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
    headers: { "User-Agent": UA, Accept: "application/vnd.github.raw" },
  }).then((r) => (r.ok ? r.text() : ""));
  return {
    title: `${owner}/${repo}`,
    markdown: [
      `# ${owner}/${repo}`,
      `GitHub: ${meta.html_url ?? `https://github.com/${owner}/${repo}`}`,
      `${meta.description ?? ""} · ★ ${meta.stargazers_count ?? "?"} · ${meta.language ?? ""}`,
      "",
      "## README",
      "",
      readme || "(no README)",
    ].join("\n"),
  };
}
