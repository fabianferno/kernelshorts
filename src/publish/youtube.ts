import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { PATHS, env } from "./settings.js";
import { readJsonIfExists, writeSecretJson } from "./store.js";

/**
 * YouTube Data API v3, called directly (no googleapis dependency).
 *
 * Setup (once): a Google Cloud project with "YouTube Data API v3" enabled and
 * an OAuth client of type "Desktop app" → YOUTUBE_CLIENT_ID/SECRET in .env.
 * Put the OAuth consent screen in "In production": in "Testing", Google
 * expires refresh tokens after 7 days for this scope.
 *
 * Uploads: 1 unit each in the Video Uploads bucket, 100/day by default.
 * Scheduling is native — upload private with status.publishAt and YouTube
 * flips it public at the slot, Mac on or not.
 */

const AUTH_FILE = join(PATHS.auth, "youtube.json");
/** Full scope: upload, read back status, and delete a cancelled upload. */
const SCOPE = "https://www.googleapis.com/auth/youtube";
const API = "https://www.googleapis.com/youtube/v3";

interface YtAuth {
  refresh_token: string;
  channel_id?: string;
  channel_title?: string;
  obtained_at: string;
}

function client(): { id: string; secret: string } {
  if (!env.youtubeClientId || !env.youtubeClientSecret) {
    throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET missing from .env (see docs/publishing.md)");
  }
  return { id: env.youtubeClientId, secret: env.youtubeClientSecret };
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const j = (await r.json()) as Record<string, unknown>;
  if (!r.ok) {
    const hint =
      j.error === "invalid_grant"
        ? " — the YouTube sign-in expired or was revoked; run `pnpm post auth youtube` again" +
          " (and make sure the consent screen is 'In production', not 'Testing')"
        : "";
    throw new Error(`Google token endpoint: ${j.error} ${j.error_description ?? ""}${hint}`);
  }
  return j;
}

/** One-time browser sign-in (loopback redirect + PKCE). */
export async function authorizeYouTube(): Promise<YtAuth> {
  const { id, secret } = client();
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const codeP = new Promise<string>((ok, fail) => ((resolveCode = ok), (rejectCode = fail)));
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/") return void res.writeHead(404).end();
    const code = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    if (u.searchParams.get("state") !== state || (!code && !err)) return void res.writeHead(400).end("bad request");
    res.writeHead(200, { "Content-Type": "text/plain" }).end(
      err ? `Sign-in failed: ${err}. You can close this tab.` : "kernel.girl is connected to YouTube. You can close this tab.",
    );
    if (err) rejectCode(new Error(`Google sign-in: ${err}`));
    else resolveCode(code!);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: id,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  console.log(`Opening the Google sign-in. If no browser opens, visit:\n${url}\n`);
  execFile("open", [url.toString()], () => {});

  try {
    const code = await Promise.race([
      codeP,
      new Promise<never>((_, fail) => setTimeout(() => fail(new Error("sign-in timed out after 5 min")), 300_000)),
    ]);
    const tok = await tokenRequest({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    if (!tok.refresh_token) throw new Error("Google returned no refresh token");
    const auth: YtAuth = { refresh_token: String(tok.refresh_token), obtained_at: new Date().toISOString() };
    const ch = await api<{ items?: { id: string; snippet: { title: string } }[] }>(
      "GET", `/channels?part=snippet&mine=true`, String(tok.access_token),
    );
    const channel = ch.items?.[0];
    if (!channel) throw new Error("This Google account has no YouTube channel yet — create one, then sign in again");
    auth.channel_id = channel.id;
    auth.channel_title = channel.snippet.title;
    await writeSecretJson(AUTH_FILE, auth);
    return auth;
  } finally {
    server.close();
  }
}

let cached: { token: string; until: number } | undefined;
async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const auth = await readJsonIfExists<YtAuth>(AUTH_FILE);
  if (!auth) throw new Error("YouTube is not connected — run `pnpm post auth youtube`");
  const { id, secret } = client();
  const tok = await tokenRequest({
    refresh_token: auth.refresh_token,
    client_id: id,
    client_secret: secret,
    grant_type: "refresh_token",
  });
  cached = { token: String(tok.access_token), until: Date.now() + Number(tok.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function api<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token ?? (await accessToken())}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new Error(`YouTube ${method} ${path.split("?")[0]}: ${r.status} ${j.error?.message ?? ""}`);
  return j;
}

export async function youtubeAccount(): Promise<YtAuth | undefined> {
  return readJsonIfExists<YtAuth>(AUTH_FILE);
}

/**
 * Resumable upload. With `publishAt` in the future the video is uploaded
 * private and YouTube publishes it then; otherwise it goes public now.
 */
export async function uploadShort(
  file: string,
  meta: { title: string; description: string; tags: string[] },
  publishAt: Date | null,
): Promise<{ videoId: string; url: string; scheduled: boolean }> {
  const token = await accessToken();
  const { size } = await stat(file);
  const scheduled = !!publishAt && publishAt.getTime() > Date.now() + 60_000;
  const resource = {
    snippet: {
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      categoryId: "28", // Science & Technology
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
    },
    status: {
      privacyStatus: scheduled ? "private" : "public",
      ...(scheduled ? { publishAt: publishAt!.toISOString() } : {}),
      selfDeclaredMadeForKids: false,
      embeddable: true,
    },
  };
  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(resource),
    },
  );
  const session = init.headers.get("location");
  if (!init.ok || !session) {
    const j = (await init.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`YouTube upload init: ${init.status} ${j.error?.message ?? ""}`);
  }
  const put = await fetch(session, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(size) },
    body: await readFile(file),
  });
  const v = (await put.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!put.ok || !v.id) throw new Error(`YouTube upload: ${put.status} ${v.error?.message ?? ""}`);
  return { videoId: v.id, url: `https://youtube.com/shorts/${v.id}`, scheduled };
}

export async function videoStatus(
  videoId: string,
): Promise<{ privacyStatus: string; uploadStatus: string; rejectionReason?: string } | undefined> {
  const j = await api<{ items?: { status: { privacyStatus: string; uploadStatus: string; rejectionReason?: string } }[] }>(
    "GET", `/videos?part=status&id=${encodeURIComponent(videoId)}`,
  );
  return j.items?.[0]?.status;
}

export async function deleteVideo(videoId: string): Promise<void> {
  await api("DELETE", `/videos?id=${encodeURIComponent(videoId)}`);
}
