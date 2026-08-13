import { NextResponse } from "next/server";
import { z } from "zod";
import { saveSubscription, vapidPublicKey } from "@worker/notify/push";

export const dynamic = "force-dynamic";

/**
 * GET returns the VAPID public key the browser needs for
 * `pushManager.subscribe`. It is served from here rather than baked in as a
 * NEXT_PUBLIC_ var because the key lives in the repo-root `.env` that only the
 * server process reads — and a second copy of it in `web/` is a second thing to
 * rotate. The public key is public by definition; there is nothing to leak.
 *
 * A missing key returns `configured: false` so the UI can say "push is not
 * configured on the server" instead of failing at `subscribe()` with an
 * InvalidAccessError the user cannot interpret.
 */
export async function GET() {
  const key = vapidPublicKey();
  return NextResponse.json(
    { configured: Boolean(key), publicKey: key ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * The browser's PushSubscription, as `subscription.toJSON()` produces it.
 * `expirationTime` rides along in that JSON and is ignored — push.ts stores
 * only what `webpush.sendNotification` needs.
 */
const Body = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
  label: z.string().trim().min(1).max(120).optional(),
});

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid subscription", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const doc = await saveSubscription(parsed.data.subscription, parsed.data.label);
    // The endpoint is the credential half of a push subscription; echoing it
    // back in full serves nothing.
    return NextResponse.json({
      saved: true,
      endpoint: `${doc.endpoint.slice(0, 48)}…`,
      label: doc.label ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
