/**
 * Push service worker.
 *
 * Served from /sw.js so its scope is the whole origin — a worker registered
 * from a subdirectory can only receive push for that subdirectory, and the
 * gate notifications have to arrive no matter which page was last open.
 *
 * The payload is the `{title, body, url}` JSON that src/notify/push.ts sends.
 */

self.addEventListener("push", (event) => {
  // A push with no data is still a real wake-up (some services strip payloads
  // on delivery retries). Showing a generic notification beats showing none:
  // on Chrome, a push event that ends without showNotification burns the
  // origin's "silent push" budget and eventually unsubscribes us.
  let payload = { title: "kernelshorts", body: "A run needs attention.", url: "/" };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // Gate-open, escalation and failure for one run collapse onto each other
      // rather than stacking three notifications for the same problem.
      tag: payload.url,
      renotify: true,
      data: { url: payload.url },
      requireInteraction: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/";

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus an existing dashboard tab rather than opening a fourth copy of
      // it; navigate that tab if it is not already on the right run.
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if (client.url !== new URL(target, self.location.origin).href) {
            await client.navigate(target);
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
