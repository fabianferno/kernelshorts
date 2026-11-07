import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * Instagram (with Instagram Login) only accepts a video by public URL — it
 * cURLs the file itself. So for the few minutes of a publish, ONE file is
 * served from this Mac at an unguessable path through a Cloudflare quick
 * tunnel (free, no account), and both are torn down afterwards.
 *
 * Every other path returns 404; the tunnel exists only inside `withPublicFile`.
 */

function serveOne(path: string, size: number, token: string): Promise<Server> {
  const route = `/${token}.mp4`;
  const server = createServer((req, res) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || req.url !== route) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0;
    let end = size - 1;
    if (range) {
      if (range[1]) start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
      if (!range[1] && range[2]) {
        start = Math.max(0, size - Number(range[2]));
        end = size - 1;
      }
      if (start > end || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
    }
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(path, { start, end }).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok(server));
  });
}

async function waitReachable(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`temporary link never became reachable (${last})`);
}

export async function withPublicFile<T>(path: string, fn: (url: string) => Promise<T>): Promise<T> {
  const { size } = await stat(path);
  const token = randomBytes(24).toString("hex");
  const server = await serveOne(path, size, token);
  const port = (server.address() as AddressInfo).port;

  const proc = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const base = await new Promise<string>((ok, fail) => {
      let log = "";
      const timer = setTimeout(() => fail(new Error(`cloudflared gave no URL in 60 s:\n${log.slice(-800)}`)), 60_000);
      const onData = (b: Buffer) => {
        log += b.toString();
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
        if (m) {
          clearTimeout(timer);
          ok(m[0]);
        }
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.once("error", (e) => {
        clearTimeout(timer);
        fail(
          (e as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error("cloudflared is not installed (brew install cloudflared)")
            : e,
        );
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        fail(new Error(`cloudflared exited (${code}):\n${log.slice(-800)}`));
      });
    });
    const url = `${base}/${token}.mp4`;
    // New trycloudflare hostnames can take 1–2 min to resolve (measured 83 s, 2026-11-07).
    await waitReachable(url, 240_000);
    return await fn(url);
  } finally {
    proc.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
