/**
 * Automated posting to Instagram Reels + YouTube Shorts (M5).
 *
 *   pnpm post auth youtube|instagram       one-time connect (docs/publishing.md)
 *   pnpm post status                       accounts, scheduler, queue
 *   pnpm post queue <reel.mp4> <captions.json> [--only instagram|youtube]
 *                    [--at YYYY-MM-DDTHH:MM] [--dry-run] [--force]
 *   pnpm post list
 *   pnpm post cancel <id> [--only instagram|youtube]
 *   pnpm post due                          one scheduler pass (launchd runs this)
 *   pnpm post agent install|uninstall|status
 *
 * `queue` is run only after the user approves the captions (Gate 4) — it is
 * the moment a reel is committed to going public.
 */
import { parseArgs } from "node:util";
import { queuePost, runDue, cancelPost, describePosts, type Platform } from "../src/publish/run.js";
import { authorizeYouTube, youtubeAccount } from "../src/publish/youtube.js";
import { authorizeInstagram, instagramAccount } from "../src/publish/instagram.js";
import { installAgent, uninstallAgent, agentStatus } from "../src/publish/agent.js";
import { postingSettings } from "../src/publish/settings.js";
import { describeSlot } from "../src/publish/slots.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: "string" },
    at: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});
const [cmd, ...rest] = positionals;
const only = values.only as Platform | undefined;
if (only && only !== "instagram" && only !== "youtube") throw new Error("--only must be instagram or youtube");

async function main(): Promise<void> {
  switch (cmd) {
    case "auth": {
      if (rest[0] === "youtube") {
        const a = await authorizeYouTube();
        console.log(`YouTube connected: ${a.channel_title} (${a.channel_id})`);
      } else if (rest[0] === "instagram") {
        const a = await authorizeInstagram();
        console.log(`Instagram connected: @${a.username} (${a.account_type ?? "professional"})`);
      } else throw new Error("usage: pnpm post auth youtube|instagram");
      return;
    }
    case "status": {
      const s = postingSettings();
      const y = await youtubeAccount();
      const i = await instagramAccount();
      console.log(`Instagram  ${i ? `@${i.username}` : "not connected"}   slot ${s.instagram.time} ${s.timezone}`);
      console.log(`YouTube    ${y ? y.channel_title : "not connected"}   slot ${s.youtube.time} ${s.timezone}`);
      console.log(`Scheduler  ${await agentStatus()}\n`);
      console.log(await describePosts());
      return;
    }
    case "queue": {
      const [video, captions] = rest;
      if (!video || !captions) throw new Error("usage: pnpm post queue <reel.mp4> <captions.json>");
      const rec = await queuePost(video, captions, { only, at: values.at, force: values.force, dryRun: values["dry-run"] });
      const tz = postingSettings().timezone;
      console.log(`${values["dry-run"] ? "[dry run] would queue" : "Queued"} ${rec.id}`);
      if (rec.instagram) console.log(`  Instagram  ${describeSlot(new Date(rec.instagram.slot), tz)}  (${rec.instagram.status})`);
      if (rec.youtube)
        console.log(
          `  YouTube    ${describeSlot(new Date(rec.youtube.slot), tz)}  (${rec.youtube.status}${rec.youtube.url ? ` ${rec.youtube.url}` : ""}` +
            `${rec.youtube.last_error ? `; ${rec.youtube.last_error} — will retry` : ""})`,
        );
      if (!values["dry-run"] && rec.instagram && !/installed/.test(await agentStatus()))
        console.log("\n  ! The scheduler isn't installed, so Instagram won't post. Run: pnpm post agent install");
      return;
    }
    case "list":
      console.log(await describePosts());
      return;
    case "cancel": {
      if (!rest[0]) throw new Error("usage: pnpm post cancel <id>");
      await cancelPost(rest[0], only);
      console.log(`Cancelled ${rest[0]}${only ? ` on ${only}` : ""}`);
      return;
    }
    case "due":
      await runDue();
      return;
    case "agent": {
      if (rest[0] === "install") console.log(`Scheduler installed: ${await installAgent()}`);
      else if (rest[0] === "uninstall") {
        await uninstallAgent();
        console.log("Scheduler removed");
      } else console.log(await agentStatus());
      return;
    }
    default:
      throw new Error("usage: pnpm post auth|status|queue|list|cancel|due|agent  (see scripts/post.ts)");
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
