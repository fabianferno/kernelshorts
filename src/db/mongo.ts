import { MongoClient, type Db } from "mongodb";
import { config } from "../config.js";

let client: MongoClient | undefined;

/** Lazily opens one shared connection. Throws on failure — no offline mode. */
export async function db(): Promise<Db> {
  if (!client) {
    // ignoreUndefined is the fix for a whole class of bug, not a preference.
    //
    // By default the driver PERSISTS an undefined field as null rather than
    // omitting it. Every optional field in this codebase is `z.string()
    // .optional()`, which rejects null — so writing a document with an absent
    // optional and reading it back throws on our own data. It cost a run:
    // approving a gate with no comment stored `comment: null`, and the parse
    // inside waitForGate's poll then killed the run that was waiting for that
    // approval. The dashboard's runs list died the same way on
    // `gate_a.comment`. With this, absent means absent, at the boundary where
    // it goes wrong instead of in every schema that reads it back.
    client = new MongoClient(config.mongo.url, {
      serverSelectionTimeoutMS: 15_000,
      ignoreUndefined: true,
    });
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
  /** Web push endpoints registered by the dashboard (PRD §2 notifications). */
  pushSubscriptions: "push_subscriptions",
} as const;
