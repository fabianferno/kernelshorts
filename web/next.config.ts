import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

/**
 * The worker's `.env` lives at the repo root, one level up from this app.
 * Next only auto-loads `.env` from its own directory, and duplicating a file
 * full of live Atlas/AWS credentials into `web/` is exactly how a secret ends
 * up in the wrong git history. next.config is evaluated in the same process
 * that serves requests under `next dev` / `next start`, so populating
 * process.env here reaches the server components and route handlers.
 * On a hosted deploy the platform sets these vars and this call is a no-op
 * (dotenv never overwrites an already-set variable).
 */
loadEnv({ path: resolve(process.cwd(), "..", ".env"), quiet: true });

const nextConfig: NextConfig = {
  /**
   * The zod schemas, the Mongo client and `resolveGate` are imported straight
   * from `../src` rather than copied. Two definitions of RunState would drift
   * apart within a week, and the gate status transitions must have exactly one
   * implementation — the dashboard writing its own would be a second source of
   * truth for whether a run is blocked.
   */
  experimental: { externalDir: true },
  /** `mongodb` pulls optional native deps (kerberos, aws4, snappy) it does not
   *  need; bundling them fails resolution. Keep it a runtime require. */
  serverExternalPackages: ["mongodb", "web-push"],

  /** Two lockfiles (repo root + web/) make Next guess at the workspace root and
   *  warn. The root is the repo, because `../src` is part of the build. */
  outputFileTracingRoot: resolve(process.cwd(), ".."),

  webpack(webpackConfig) {
    /**
     * The worker is NodeNext ESM: its files import each other as `./config.js`
     * while the file on disk is `config.ts`. tsc understands that mapping;
     * webpack does not, and every `@worker/*` import drags in a graph of them.
     */
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };

    /**
     * `serverExternalPackages` does not cover `mongodb` when it is reached
     * through an `externalDir` import (`../src/db/mongo.ts`), so webpack
     * follows the driver's optional-dependency probes and warns about modules
     * we deliberately do not install. These are alternate auth mechanisms and
     * compressors the Atlas SCRAM connection never touches; `false` is
     * webpack's way of saying "genuinely absent", which is the truth.
     */
    webpackConfig.resolve.fallback = {
      ...webpackConfig.resolve.fallback,
      aws4: false,
      kerberos: false,
      snappy: false,
      socks: false,
      "gcp-metadata": false,
      "@mongodb-js/zstd": false,
      "@aws-sdk/credential-providers": false,
      "mongodb-client-encryption": false,
    };
    return webpackConfig;
  },
};

export default nextConfig;
