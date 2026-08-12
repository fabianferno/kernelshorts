import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import { readFile } from "node:fs/promises";
import { config } from "../config.js";

const client = new BedrockRuntimeClient({
  region: config.bedrock.region,
  credentials: config.bedrock.credentials,
});

export interface ConverseOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  modelId?: string;
}

export interface ConverseResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * One real Bedrock Converse call. Every LLM step in the pipeline goes through
 * here so cost telemetry (PRD §8: tokens + wall clock per phase) has a single
 * chokepoint.
 */
export async function converse(
  messages: Message[],
  opts: ConverseOptions = {},
): Promise<ConverseResult> {
  const started = Date.now();
  const res = await client.send(
    new ConverseCommand({
      modelId: opts.modelId ?? config.bedrock.modelId,
      messages,
      // Gemma on Bedrock rejects a top-level `system` block; fold it into the
      // first user turn instead. Claude models accept either.
      ...(opts.system && !isGemma(opts.modelId ?? config.bedrock.modelId)
        ? { system: [{ text: opts.system }] }
        : {}),
      inferenceConfig: {
        maxTokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
      },
    }),
  );

  const text = (res.output?.message?.content ?? [])
    .map((b) => ("text" in b ? b.text : ""))
    .join("")
    .trim();

  return {
    text,
    inputTokens: res.usage?.inputTokens ?? 0,
    outputTokens: res.usage?.outputTokens ?? 0,
    latencyMs: res.metrics?.latencyMs ?? Date.now() - started,
  };
}

function isGemma(modelId: string): boolean {
  return modelId.startsWith("google.gemma");
}

/** Convenience: a single user turn, with the system prompt prepended for models
 *  (like Gemma) that have no separate system role. */
export function userTurn(text: string, system?: string): Message[] {
  const body = system ? `${system}\n\n---\n\n${text}` : text;
  return [{ role: "user", content: [{ text: body }] }];
}

/** Build a vision turn from real image files on disk. Verified working with
 *  google.gemma-3-27b-it on a frame sampled from the M0 export. */
export async function visionTurn(
  imagePaths: string[],
  text: string,
  system?: string,
): Promise<Message[]> {
  const blocks: ContentBlock[] = [];
  for (const p of imagePaths) {
    const format = p.endsWith(".png") ? "png" : "jpeg";
    blocks.push({ image: { format, source: { bytes: await readFile(p) } } });
  }
  blocks.push({ text: system ? `${system}\n\n---\n\n${text}` : text });
  return [{ role: "user", content: blocks }];
}

/** Parse a JSON object out of a model response, tolerating ```json fences.
 *  Throws on unparseable output — the caller retries with feedback rather than
 *  substituting a default. */
export function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error(`No JSON found in model response: ${raw.slice(0, 300)}`);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return JSON.parse(body.slice(start, end + 1)) as T;
}
