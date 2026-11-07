import { mkdir, readFile, readdir, rename, writeFile, open, stat, unlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Post records: one small JSON file per queued reel in ~/pipeline/posts.
 * Local files rather than Mongo — the scheduler has to work offline-first and
 * the Atlas cluster is a shared free tier.
 */

export type IgStatus = "scheduled" | "publishing" | "published" | "failed" | "cancelled";
export type YtStatus = "pending" | "scheduled" | "published" | "failed" | "cancelled";

interface PlatformState {
  /** ISO instant the post should be live. */
  slot: string;
  attempts: number;
  last_error?: string;
  /** Don't retry before this ISO instant. */
  next_try?: string;
  url?: string;
  published_at?: string;
}

export interface IgState extends PlatformState {
  status: IgStatus;
  caption: string;
  /** Set before media_publish so a crash mid-publish can't double-post. */
  container_id?: string;
  media_id?: string;
}

export interface YtState extends PlatformState {
  status: YtStatus;
  title: string;
  description: string;
  tags: string[];
  video_id?: string;
}

export interface PostRecord {
  id: string;
  created_at: string;
  /** The approved final cut in ~/pipeline/out. */
  video: string;
  /** Faststart/128k-AAC copy that is actually uploaded. */
  publish_video: string;
  sha256: string;
  instagram?: IgState;
  youtube?: YtState;
}

export async function savePost(dir: string, rec: PostRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${rec.id}.json`);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(rec, null, 2) + "\n");
  await rename(tmp, path); // atomic: a crash never leaves half a record
}

export async function loadPost(dir: string, id: string): Promise<PostRecord> {
  return JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as PostRecord;
}

export async function listPosts(dir: string): Promise<PostRecord[]> {
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  return Promise.all(names.map((n) => loadPost(dir, n.slice(0, -5))));
}

/** Slots already claimed on a platform (cancelled/failed ones free theirs). */
export function takenSlots(posts: PostRecord[], platform: "instagram" | "youtube"): Date[] {
  return posts
    .map((p) => p[platform])
    .filter((s): s is IgState | YtState => !!s && s.status !== "cancelled" && s.status !== "failed")
    .map((s) => new Date(s.slot));
}

/**
 * One scheduler run at a time. launchd fires every few minutes and a
 * publish can take longer than that; a second run must not pick up the same
 * post. A lock older than 30 minutes is a crashed run and is taken over.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T | "locked"> {
  await mkdir(dir, { recursive: true });
  const lock = join(dir, ".lock");
  try {
    const fh = await open(lock, "wx");
    await fh.writeFile(String(process.pid));
    await fh.close();
  } catch {
    const age = Date.now() - (await stat(lock)).mtimeMs;
    if (age < 30 * 60_000) return "locked";
    await writeFile(lock, String(process.pid));
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

/** Auth files hold refresh tokens: owner read/write only. */
export async function writeSecretJson(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as T;
}
