import webpush, { type PushSubscription, WebPushError } from "web-push";
import { db, COLLECTIONS } from "../db/mongo.js";
import { config } from "../config.js";

/**
 * Web push notifications (PRD §2: "notifications on gate-open, escalation and
 * failure").
 *
 * Push is the one part of this pipeline that is allowed to be absent: it is
 * not on the critical path of making a video. So a missing VAPID key logs a
 * loud line and returns `{ sent: 0, disabled: true }` — it never throws, and it
 * never claims a send that did not happen.
 *
 * Telegram is deliberately not implemented (no bot token exists). An adapter
 * with no live implementation would be a stub, and PRD §0 forbids that.
 */

export interface PushSubscriptionDoc {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Free-form, for telling "my phone" from "my laptop" in the dashboard. */
  label?: string;
  created_at: string;
  last_ok_at?: string;
}

let configured = false;

function ready(): boolean {
  const { publicKey, privateKey, subject } = config.push;
  if (!publicKey || !privateKey) return false;
  if (!configured) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
  }
  return true;
}

async function collection() {
  const col = (await db()).collection<PushSubscriptionDoc>(COLLECTIONS.pushSubscriptions);
  await col.createIndex({ endpoint: 1 }, { unique: true });
  return col;
}

/** Idempotent: the browser hands back the same endpoint on every page load. */
export async function saveSubscription(
  sub: PushSubscription,
  label?: string,
): Promise<PushSubscriptionDoc> {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    throw new Error("Push subscription is missing endpoint or keys");
  }
  const doc: PushSubscriptionDoc = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    label,
    created_at: new Date().toISOString(),
  };
  const col = await collection();
  await col.updateOne(
    { endpoint: doc.endpoint },
    { $set: { keys: doc.keys, label }, $setOnInsert: { created_at: doc.created_at } },
    { upsert: true },
  );
  return doc;
}

export async function listSubscriptions(): Promise<PushSubscriptionDoc[]> {
  return (await collection()).find({}).toArray();
}

export interface NotifyResult {
  sent: number;
  failed: number;
  /** Endpoints the push service reported permanently gone (404/410). */
  pruned: number;
  disabled: boolean;
}

/**
 * Sends to every registered subscription.
 *
 * 404/410 from a push service means the subscription is permanently dead (the
 * browser dropped it or the user cleared site data) — the spec says never
 * retry those, so they are deleted. Any other status is transient-ish and the
 * row is kept.
 */
export async function notify(msg: {
  title: string;
  body: string;
  url?: string;
}): Promise<NotifyResult> {
  if (!ready()) {
    console.warn(
      "[push] NOTIFICATIONS DISABLED — VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not set. " +
        `Not delivered: ${msg.title} — ${msg.body}`,
    );
    return { sent: 0, failed: 0, pruned: 0, disabled: true };
  }

  const subs = await listSubscriptions();
  if (subs.length === 0) {
    console.warn(`[push] no subscriptions registered; not delivered: ${msg.title}`);
    return { sent: 0, failed: 0, pruned: 0, disabled: false };
  }

  const payload = JSON.stringify({
    title: msg.title,
    body: msg.body,
    url: msg.url ?? config.dashboardUrl,
  });

  const col = await collection();
  let sent = 0;
  let failed = 0;
  let pruned = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload,
        // A gate can sit open overnight; 24h keeps it queued for a phone that
        // is off rather than dropping it silently.
        { TTL: 86_400 },
      );
      sent++;
      await col.updateOne(
        { endpoint: sub.endpoint },
        { $set: { last_ok_at: new Date().toISOString() } },
      );
    } catch (err) {
      const status = err instanceof WebPushError ? err.statusCode : undefined;
      if (status === 404 || status === 410) {
        await col.deleteOne({ endpoint: sub.endpoint });
        pruned++;
      } else {
        failed++;
        console.warn(
          `[push] send failed (${status ?? "no status"}) for ${sub.endpoint.slice(0, 48)}…: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }
  console.log(`[push] "${msg.title}" → sent ${sent}, failed ${failed}, pruned ${pruned}`);
  return { sent, failed, pruned, disabled: false };
}

/** The key the web app needs to call `pushManager.subscribe`. */
export function vapidPublicKey(): string | undefined {
  return config.push.publicKey;
}
