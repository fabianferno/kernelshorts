import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { transcribeFile } from "../verify/timeline.js";
import { wordsFromTokens } from "../tts/voice.js";

const exec = promisify(execFile);

/**
 * A file on disk as source material: notes, a doc, a PDF, a recording.
 *   .md .txt .html          read as text
 *   .docx .doc .rtf .pages  converted with macOS textutil
 *   .pdf                    pointed at — Claude Code reads PDFs natively
 *   audio / video           transcribed with Soniox STT
 *   images                  pointed at — Claude Code reads images natively
 */
export function asLocalPath(input: string): string | undefined {
  const p = resolve(input.replace(/^~(?=\/)/, homedir()));
  return existsSync(p) ? p : undefined;
}

const AV = /\.(mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|flac|ogg)$/i;
const IMG = /\.(png|jpe?g|webp|heic|gif)$/i;

export async function readLocalSource(path: string): Promise<{ title: string; markdown: string }> {
  const ext = extname(path).toLowerCase();
  const name = basename(path, ext);
  const head = [`# ${name}`, `Local file: ${path}`, `Size: ${((await stat(path)).size / 1024).toFixed(0)} KB`, ""];

  if ([".md", ".txt", ".html", ".htm", ".csv", ".json"].includes(ext)) {
    return { title: name, markdown: [...head, "## Content", "", await readFile(path, "utf8")].join("\n") };
  }
  if ([".docx", ".doc", ".rtf", ".pages", ".odt"].includes(ext)) {
    const { stdout } = await exec("textutil", ["-convert", "txt", "-stdout", path], { maxBuffer: 1 << 26 });
    return { title: name, markdown: [...head, "## Content (textutil)", "", stdout].join("\n") };
  }
  if (ext === ".pdf") {
    return {
      title: name,
      markdown: [...head, "## Content", "", `PDF — read it directly with the Read tool: ${path}`, "(use the `pages` parameter for long PDFs)"].join("\n"),
    };
  }
  if (AV.test(path)) {
    const t = await transcribeFile(path);
    const words = wordsFromTokens(t.tokens);
    const text = words.map((w) => w.word).join(" ");
    return { title: name, markdown: [...head, "## Transcript (Soniox STT)", "", text].join("\n") };
  }
  if (IMG.test(path)) {
    return { title: name, markdown: [...head, "## Image", "", `Look at it with the Read tool: ${path}`].join("\n") };
  }
  throw new Error(`don't know how to read ${ext} files (${path})`);
}
