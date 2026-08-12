import { readFileSync } from "node:fs";
import { RunState } from "./src/shared/schemas.js";
import { buildTimeline } from "./src/edit/build-timeline.js";
import { PalmierClient } from "./src/palmier/client.js";
import { closeDb } from "./src/db/mongo.js";
const s = RunState.parse(JSON.parse(readFileSync("/Users/fabianferno/pipeline/runs/2026-08-12/state.json","utf8")));
const ws = { root: s.workspace, exports: `${s.workspace}/exports`, checkpoints: `${s.workspace}/checkpoints` };
const c = new PalmierClient({ requestTimeoutMs: 300000 });
await c.connect();
try {
  const r = await buildTimeline({ client: c, script: s.script!, manifest: s.manifest!, workspace: ws,
    onProgress: (m) => console.log(`${new Date().toISOString().slice(11,19)}  ${m}`) });
  console.log("OK", r.exportPath, r.totalFrames);
} catch (e) { console.log("FAILED:", (e as Error).message); }
finally { await c.close(); await closeDb(); }
