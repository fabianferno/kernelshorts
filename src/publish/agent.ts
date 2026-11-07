import { writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PATHS } from "./settings.js";

const exec = promisify(execFile);

/**
 * The background scheduler: a per-user launchd agent that runs
 * `post due` every 5 minutes while the Mac is awake (launchd also fires it
 * once on wake if an interval was missed during sleep). It does no network
 * work unless something is due.
 */

export const LABEL = "com.kernelshorts.post";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const INTERVAL_S = 300;

function plist(repo: string): string {
  const node = process.execPath;
  const tsxCli = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
  const path = [dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const args = [node, tsxCli, join(repo, "scripts", "post.ts"), "due"].map((a) => `    <string>${esc(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${esc(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(path)}</string></dict>
  <key>StartInterval</key><integer>${INTERVAL_S}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(join(PATHS.logs, "post.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(PATHS.logs, "post.log"))}</string>
</dict>
</plist>
`;
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;

export async function installAgent(repo = resolve(process.cwd())): Promise<string> {
  await mkdir(dirname(PLIST), { recursive: true });
  await mkdir(PATHS.logs, { recursive: true });
  await exec("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  await writeFile(PLIST, plist(repo));
  await exec("launchctl", ["bootstrap", domain(), PLIST]);
  return PLIST;
}

export async function uninstallAgent(): Promise<void> {
  await exec("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  if (existsSync(PLIST)) await unlink(PLIST);
}

export async function agentStatus(): Promise<string> {
  if (!existsSync(PLIST)) return "not installed";
  try {
    const { stdout } = await exec("launchctl", ["print", `${domain()}/${LABEL}`]);
    const state = /state = (\S+)/.exec(stdout)?.[1] ?? "loaded";
    const last = /last exit code = (.+)/.exec(stdout)?.[1];
    return `installed (${state}${last ? `, last exit ${last}` : ""}); log: ${join(PATHS.logs, "post.log")}`;
  } catch {
    return "plist present but not loaded — run `pnpm post agent install`";
  }
}
