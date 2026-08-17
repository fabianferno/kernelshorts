import "dotenv/config";
import { z } from "zod";
import { resolve } from "node:path";

/**
 * Config is validated once, at process start, and fails loudly.
 *
 * Per PRD §0 there is no fallback branch here: a missing credential halts the
 * process rather than degrading to a mock. If you are blocked on a credential,
 * that is a blocked task to report, not a code path to write.
 */
const Env = z.object({
  // Bedrock — verified live 2026-08-12 against ap-south-1.
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
  /**
   * Bedrock model id for the pipeline's text/vision agents.
   * NOTE: `google.gemma-4-31b` does not exist on Bedrock and returns
   * ValidationException. The real Gemma ids in ap-south-1 are
   * google.gemma-3-{4b,12b,27b}-it. 27b is verified working for both text
   * and vision (see docs/M0-verification.md).
   */
  BEDROCK_MODEL: z.string().min(1),
  /** Region the model is actually invoked in; falls back to AWS_REGION. */
  BEDROCK_MANTLE_REGION: z.string().min(1).optional(),
  /**
   * Model for the Layer-2 vision reviewer. Separate from BEDROCK_MODEL because
   * the two jobs have different requirements and Gemma FAILED the vision one:
   * given a blank grey video with the real audio, gemma-3-27b scored it 3.67 —
   * HIGHER than the real short (3.33) — and justified visual_relevance=4 by
   * describing Hacker News screen recordings that were not in any frame. It
   * was grading the script, not the video. qwen3-vl scores the same pair
   * 4.00 vs 1.50 and names the grey screens explicitly.
   */
  BEDROCK_VISION_MODEL: z.string().min(1).default("qwen.qwen3-vl-235b-a22b"),

  MONGO_URL: z.string().startsWith("mongodb"),
  /** The Atlas cluster is shared with other projects — always namespace. */
  MONGO_DB: z.string().default("kernelshorts"),

  PEXELS_API_KEY: z.string().min(1),
  PIXABAY_API_KEY: z.string().min(1),

  /** Soniox: speech-to-TEXT only on this account. Used for the export
   *  script-fidelity verifier (PRD §5 Layer 1), NOT for voiceover. */
  SONIOX_API_KEY: z.string().min(1),

  /**
   * Web push (PRD §2: notify on gate-open, escalation, failure).
   *
   * OPTIONAL on purpose, and the one exception to the "fail loud on a missing
   * credential" rule above — a missing VAPID key must not stop a video being
   * made. It degrades to "notifications disabled", logged loudly, and every
   * gate is still visible in the dashboard and in the terminal. What it must
   * never do is pretend a notification was delivered.
   */
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  /** web-push requires a mailto: or https: subject in the VAPID JWT. */
  VAPID_SUBJECT: z.string().min(1).optional(),
  /** Base URL used to build the deep link in a notification. */
  DASHBOARD_URL: z.string().url().optional(),

  /** Port for the backend daemon (src/server.ts). The dashboard is on 3111. */
  SERVER_PORT: z.coerce.number().int().positive().default(3112),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  throw new Error(`Invalid environment — fix .env before running:\n${missing.join("\n")}`);
}

const env = parsed.data;

export const config = {
  bedrock: {
    region: env.BEDROCK_MANTLE_REGION ?? env.AWS_REGION,
    modelId: env.BEDROCK_MODEL,
    /** Vision-capable model used by the review loop. */
    visionModelId: env.BEDROCK_VISION_MODEL,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  },
  mongo: { url: env.MONGO_URL, db: env.MONGO_DB },
  stock: { pexelsKey: env.PEXELS_API_KEY, pixabayKey: env.PIXABAY_API_KEY },
  soniox: { apiKey: env.SONIOX_API_KEY },

  push: {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT ?? "mailto:disha.ai@dishacom.com",
  },
  dashboardUrl: env.DASHBOARD_URL,
  server: { port: env.SERVER_PORT },

  /** Palmier Pro MCP — verified live (PRD §0.5). */
  palmierMcpUrl: "http://127.0.0.1:19789/mcp",

  paths: {
    /** Repo-local asset vault. See vault/README.md. */
    vault: resolve(process.cwd(), "vault"),
    vaultIndex: resolve(process.cwd(), "vault.index.json"),
    /** Run workspaces (PRD §2): ~/pipeline/runs/<date-slug>/ */
    runsRoot: resolve(process.env.HOME ?? "~", "pipeline/runs"),
  },

  /** Locked format decisions (PRD §0.5). */
  video: { width: 1080, height: 1920, fps: 30, targetDurationS: { min: 30, max: 60 } },
  /** PRD §5 Layer 1. Palmier does not normalize on export (−24.9 LUFS measured
   *  in M0), so this is a normalize-then-verify target, not just a check. */
  loudness: { targetLufs: -14, acceptRange: [-16, -13] as const },
} as const;

export type Config = typeof config;
