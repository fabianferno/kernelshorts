import { MongoClient, type Db } from "mongodb";
import { config } from "../config.js";

let client: MongoClient | undefined;

/** Lazily opens one shared connection. Throws on failure — no offline mode. */
export async function db(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongo.url, { serverSelectionTimeoutMS: 15_000 });
    await client.connect();
  }
  return client.db(config.mongo.db);
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = undefined;
}

/** Collection names. The Atlas cluster is shared, so everything lives under
 *  the `kernelshorts` database rather than colliding in a default db. */
export const COLLECTIONS = {
  runs: "runs",
  runEvents: "run_events",
  artifacts: "artifacts",
  approvals: "approvals",
  settings: "settings",
  assets: "assets",
  publishedTopics: "published_topics",
} as const;
