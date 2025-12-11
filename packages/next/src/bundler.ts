/**
 * esbuild-based bundler for sandbox functions.
 *
 * Collects all registered sandbox functions and bundles them into
 * a single JavaScript file that can be loaded in the sandbox runtime.
 */

import { build } from "esbuild";
import { getRegisteredFunctions, hasRegisteredFunctions } from "./registry";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

export interface BundleResult {
  bundlePath: string;
  bundleHash: string;
  functionIds: string[];
}

export async function generateBundle(outputDir: string): Promise<BundleResult | null> {
  if (!hasRegisteredFunctions()) {
    return null;
  }

  const functions = getRegisteredFunctions();

  // Generate the entry file content that exports all sandbox functions
  const entryContent = functions.map((fn) => fn.body).join("\n\n");

  // Create a temporary entry file
  const tempDir = join(outputDir, ".sandbox-temp");
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  const entryPath = join(tempDir, "sandbox-entry.ts");
  writeFileSync(entryPath, entryContent);

  // Generate hash for cache busting
  const bundleHash = createHash("sha256")
    .update(entryContent)
    .digest("hex")
    .slice(0, 16);

  // Ensure output directory exists
  const sandboxDir = join(outputDir, "static", "sandbox");
  if (!existsSync(sandboxDir)) {
    mkdirSync(sandboxDir, { recursive: true });
  }

  const bundleFilename = `bundle-${bundleHash}.js`;
  const bundlePath = join(sandboxDir, bundleFilename);

  // Bundle with esbuild
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    outfile: bundlePath,
    minify: false, // Keep readable for debugging
    treeShaking: true,
    // Don't bundle node built-ins
    external: [
      "fs",
      "fs/promises",
      "path",
      "child_process",
      "util",
      "os",
      "crypto",
      "http",
      "https",
      "stream",
      "buffer",
      "events",
      "url",
      "querystring",
      "zlib",
      "net",
      "tls",
      "dns",
    ],
  });

  // Also write a manifest file
  const manifest = {
    hash: bundleHash,
    bundleFile: bundleFilename,
    functions: functions.map((fn) => ({
      id: fn.fnId,
      sourceFile: fn.sourceFile,
    })),
  };

  const manifestPath = join(sandboxDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    bundlePath,
    bundleHash,
    functionIds: functions.map((fn) => fn.fnId),
  };
}

export function getBundleUrl(bundleHash: string): string {
  // Determine the base URL based on Vercel environment
  const baseUrl = getBaseUrl();
  return `${baseUrl}/_next/static/sandbox/bundle-${bundleHash}.js`;
}

function getBaseUrl(): string {
  if (process.env.VERCEL_ENV === "production") {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_ENV === "preview") {
    return `https://${process.env.VERCEL_BRANCH_URL}`;
  }
  // Local development
  const port = process.env.PORT || "3000";
  return `http://localhost:${port}`;
}

