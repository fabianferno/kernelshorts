# Automated posting — Instagram Reels + YouTube Shorts (M5)

After Gate 3 (final cut approved), captions are written and approved at
**Gate 4**; `pnpm post queue` then commits the reel to go out at the next
posting slot on each platform. Free, direct APIs only: no third-party
scheduler sits between the Mac and Instagram or YouTube.

```
final cut ─▶ captions (Gate 4) ─▶ pnpm post queue
                                    ├─ YouTube: uploaded now, private, publishAt = slot
                                    │           (YouTube flips it public; Mac can be off)
                                    └─ Instagram: waits in ~/pipeline/posts
                                                  launchd runs `pnpm post due` every 5 min;
                                                  at the slot the reel is served through a
                                                  temporary Cloudflare link, Instagram fetches
                                                  it, the post goes live, the link closes.
```

## Slots

Default: **7:30 pm IST** on both platforms, at most one reel per platform per
day (a backlog spreads over successive evenings). Chosen 2026-11-07 with no
follower data — it is where Indian Reels/Shorts guidance overlaps. Override in
`vault/brand/brand.json`:

```json
"posting": {
  "timezone": "Asia/Kolkata",
  "instagram": { "time": "19:30" },
  "youtube": { "time": "20:00" },
  "maxLateHours": 3
}
```

If the Mac is asleep through an Instagram slot by more than `maxLateHours`,
the post moves to the next free evening (and says so) instead of going out at
3 am. `--at 2026-11-09T21:00` on `queue` pins a specific time.

## One-time setup

### Instagram
1. Instagram app → Settings → *Account type and tools* → **Switch to
   professional account** → *Creator*. (The API can't post for personal accounts.)
2. <https://developers.facebook.com/apps> → **Create app** → use case
   *Manage messaging & content on Instagram* (Instagram API with Instagram Login).
3. In the app: *Instagram → API setup with Instagram login* → **Generate access
   tokens** → add your Instagram account (accept the tester invite in the
   Instagram app if asked) → copy the token. It needs
   `instagram_business_basic` and `instagram_business_content_publish`.
   Standard Access is enough for your own account — no App Review.
4. `.env`: `INSTAGRAM_ACCESS_TOKEN=…`
5. `pnpm post auth instagram` → prints `@handle`.

The token lasts 60 days; the scheduler refreshes it weekly into
`~/pipeline/auth/instagram.json` (mode 600). If it ever lapses (Mac off for
two months), generate a new one and repeat 4–5.

### YouTube
1. Create the channel: youtube.com → avatar → **Create a channel** (kernel.girl).
2. <https://console.cloud.google.com> → new project → *APIs & Services →
   Library* → **YouTube Data API v3** → Enable.
3. *Google Auth Platform / OAuth consent screen* → External → app name, your
   email → then **Publish app** (status *In production*). In *Testing*, Google
   expires the sign-in every 7 days.
4. *Credentials → Create credentials → OAuth client ID* → type **Desktop app**
   → `.env`: `YOUTUBE_CLIENT_ID=…`, `YOUTUBE_CLIENT_SECRET=…`
5. `pnpm post auth youtube` → a browser opens; sign in with the channel's
   account (pick the kernel.girl channel if asked). On "Google hasn't verified
   this app": *Advanced → Go to … (unsafe)* — it's your own app. Prints the
   channel name.

Uploads from unverified API projects are **not** locked to private any more
(YouTube Data API docs, checked 2026-11-07). Quota: 100 uploads/day.

### Scheduler
`pnpm post agent install` — a launchd agent (`com.kernelshorts.post`) that runs
`pnpm post due` every 5 minutes while the Mac is awake. Log:
`~/pipeline/logs/post.log`. `pnpm post agent uninstall` removes it.
Needs `cloudflared` (`brew install cloudflared`).

## Day to day

```
pnpm post status                                  # accounts, scheduler, queue
pnpm post queue <reel.mp4> <captions.json>        # after Gate 4 only
pnpm post queue … --dry-run                       # show slots, touch nothing
pnpm post list
pnpm post cancel <id> [--only instagram|youtube]  # before it goes live
```

`captions.json`:

```json
{
  "instagram": { "caption": "hook in the first 125 chars…\n\nbody\n\n#tag #tag #tag" },
  "youtube":   { "title": "≤100 chars", "description": "…sources…", "tags": ["…"] }
}
```

Leave a platform out (or `--only`) to post to one. You get a Mac notification
(and a web push, if VAPID is set up) when each post goes live, moves, or fails;
failures retry 3× at 15-minute intervals.

## Safety rails
- Nothing is posted without `queue`, and `queue` is only run after Gate 4.
- The same video file can't be queued twice (sha256) without `--force`.
- An interrupted Instagram publish is settled from its container status on
  the next run — it never publishes a second copy.
- The temporary link serves exactly one file at a random 48-hex-char path and
  exists only while Instagram is fetching it.
