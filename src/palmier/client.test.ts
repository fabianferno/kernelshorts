/**
 * Real integration test against the LIVE Palmier Pro MCP server.
 *
 * There is no mock server and no fixture. If Palmier Pro is not running with
 * its MCP server on 127.0.0.1:19789, this test fails — which is the correct
 * outcome (PRD §0).
 *
 * Run:  npx tsx src/palmier/client.test.ts
 *
 * The test creates a scratch project named "MCP Client Test" and closes it in a
 * finally block. It never touches "Palmier Sample" or any other user project.
 */

import { rm } from "node:fs/promises";

import { PalmierClient, PalmierToolError } from "./client.js";

const SCRATCH_PROJECT_NAME = "MCP Client Test";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

async function main(): Promise<void> {
  const client = new PalmierClient();

  console.log("connect()");
  await client.connect();
  check("session id issued by server", /^[0-9A-F-]{36}$/i.test(client.sessionId ?? ""), client.sessionId);
  check("server identified itself", client.serverInfo?.name === "palmier-pro", client.serverInfo);

  console.log("\nlistTools()");
  const tools = await client.listTools();
  console.log(`  ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
  const required = [
    "manage_project",
    "get_media",
    "import_media",
    "get_timeline",
    "add_clips",
    "set_clip_properties",
    "add_captions",
    "add_texts",
    "set_keyframes",
    "apply_effect",
    "export_project",
    "manage_exports",
    "get_transcript",
    "create_timeline",
    "set_project_settings",
    "manage_tracks",
    "move_clips",
    "remove_clips",
    "update_text",
  ];
  const missing = required.filter((n) => !tools.some((t) => t.name === n));
  check("every wrapped tool exists on the server", missing.length === 0, missing);

  console.log("\nerror propagation");
  let threw: unknown;
  try {
    await client.removeClips({ clipIds: ["zzzz-not-a-real-clip"] });
  } catch (e) {
    threw = e;
  }
  check("bad call throws PalmierToolError", threw instanceof PalmierToolError);
  check(
    "throws the server's real message",
    threw instanceof PalmierToolError && threw.message.includes("Clip not found"),
    threw instanceof Error ? threw.message : threw,
  );

  console.log("\nscratch 9:16 project");
  let createdProjectId: string | undefined;
  let createdProjectPath: string | undefined;
  try {
    const created = await client.manageProject({
      action: "create",
      name: SCRATCH_PROJECT_NAME,
      aspectRatio: "9:16",
      quality: "1080p",
      fps: 30,
    });
    console.log(`  create -> ${JSON.stringify(created)}`);

    const list = await client.manageProject({ action: "list" });
    const scratch = list.projects?.find((p) => p.name === SCRATCH_PROJECT_NAME);
    createdProjectId = scratch?.id;
    createdProjectPath = scratch?.path;
    check("scratch project is open and active", scratch?.isActive === true, scratch);

    const timeline = await client.getTimeline();
    console.log(`  timeline -> ${timeline.width}x${timeline.height} @ ${timeline.fps}fps`);
    check("canvas is 1080x1920", timeline.width === 1080 && timeline.height === 1920, {
      width: timeline.width,
      height: timeline.height,
    });
    check("fps is 30", timeline.fps === 30, timeline.fps);

    console.log("\nassertCanvas()");
    await client.assertCanvas(1080, 1920);
    check("assertCanvas(1080,1920) passes on a 9:16 project", true);

    let canvasThrew: unknown;
    try {
      await client.assertCanvas(1280, 720);
    } catch (e) {
      canvasThrew = e;
    }
    check("assertCanvas(1280,720) throws on a 9:16 project", canvasThrew instanceof Error);
  } finally {
    // Always clean up — the MCP server is shared state on the user's machine.
    if (createdProjectId !== undefined) {
      const closed = await client.manageProject({ action: "close", id: createdProjectId });
      console.log(`\ncleanup: closed scratch project -> ${JSON.stringify(closed)}`);
    } else {
      console.log("\ncleanup: no scratch project id captured; nothing closed");
    }
    await client.close();

    // manage_project close SAVES the .palmier package rather than deleting it,
    // so a rerun would collide on the name. Remove the scratch package too.
    // Guarded on the exact expected filename so a stray path can never delete
    // one of the user's real projects.
    if (createdProjectPath?.endsWith(`/${SCRATCH_PROJECT_NAME}.palmier`)) {
      await rm(createdProjectPath, { recursive: true, force: true });
      console.log(`cleanup: removed ${createdProjectPath}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exitCode = 1;
});
