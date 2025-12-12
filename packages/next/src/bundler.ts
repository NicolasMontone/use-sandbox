/**
 * Bundler V2: Clean bundling of .sandbox.ts files.
 *
 * Simply collects all generated .sandbox.ts files and bundles them with esbuild.
 * No regex parsing, no manual import extraction - just let esbuild do its job.
 */

import { buildSync } from "esbuild";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";

// ============================================================================
// Types
// ============================================================================

export interface BundleResult {
  bundlePath: string;
  bundleHash: string;
  sandboxFiles: string[];
}

export interface BundleManifest {
  hash: string;
  bundleFile: string;
  generatedAt: string;
  sandboxFiles: string[];
}

// ============================================================================
// State (using globalThis to survive hot-reload in dev mode)
// ============================================================================

// Using symbol keys to avoid conflicts
const SANDBOX_FILES_KEY = Symbol.for("@use-sandbox/files");
const BUNDLE_HASH_KEY = Symbol.for("@use-sandbox/bundleHash");

interface GlobalState {
  [SANDBOX_FILES_KEY]?: Map<string, string>;
  [BUNDLE_HASH_KEY]?: string | null;
}

function getSandboxFilesMap(): Map<string, string> {
  const g = globalThis as unknown as GlobalState;
  if (!g[SANDBOX_FILES_KEY]) {
    g[SANDBOX_FILES_KEY] = new Map();
  }
  return g[SANDBOX_FILES_KEY];
}

function getLastBundleHash(): string | null {
  const g = globalThis as unknown as GlobalState;
  return g[BUNDLE_HASH_KEY] ?? null;
}

function setLastBundleHash(hash: string | null): void {
  const g = globalThis as unknown as GlobalState;
  g[BUNDLE_HASH_KEY] = hash;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a sandbox file for bundling.
 * Called by the loader after transformation.
 */
export function registerSandboxFile(filePath: string, content: string): void {
  getSandboxFilesMap().set(filePath, content);
}

/**
 * Clear all registered sandbox files.
 */
export function clearSandboxFiles(): void {
  getSandboxFilesMap().clear();
  setLastBundleHash(null);
}

/**
 * Check if there are any sandbox files to bundle.
 */
export function hasSandboxFiles(): boolean {
  return getSandboxFilesMap().size > 0;
}

/**
 * Get all registered sandbox files.
 */
export function getSandboxFiles(): Map<string, string> {
  return new Map(getSandboxFilesMap());
}

/**
 * Generate the sandbox bundle synchronously.
 *
 * IMPORTANT: Turbopack runs loaders in multiple worker processes, so we cannot
 * rely on in-memory state to track all sandbox files. Instead, we:
 * 1. Write sandbox files to temp directory in the loader (each worker writes its own)
 * 2. Scan the temp directory for ALL .sandbox.ts files when bundling
 * 3. Bundle everything we find on disk
 */
export function generateBundleSync(): BundleResult | null {
  const projectRoot = process.cwd();
  const tempDir = join(projectRoot, ".next", ".sandbox-temp");
  const outputDir = join(projectRoot, ".next", "static", "sandbox");

  // Ensure directories exist
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // First, write any files from this process's Map to the temp directory
  const sandboxFilesMap = getSandboxFilesMap();
  for (const [filePath, content] of sandboxFilesMap) {
    const safeName = filePath
      .replace(projectRoot, "")
      .replace(/[/\\]/g, "__")
      .replace(/^__/, "");
    const tempPath = join(tempDir, safeName);
    writeFileSync(tempPath, content);
  }

  // Now scan the temp directory for ALL sandbox files (from all workers)
  const files = readdirSync(tempDir).filter(
    (f) => f.endsWith(".sandbox.ts") && !f.startsWith("_")
  );

  if (files.length === 0) {
    return null;
  }

  // Read all sandbox files and compute hash
  const entryPoints: string[] = [];
  const allContent: string[] = [];
  const allFilePaths: string[] = [];

  for (const file of files.sort()) {
    const tempPath = join(tempDir, file);
    const content = readFileSync(tempPath, "utf-8");
    entryPoints.push(tempPath);
    allContent.push(content);
    allFilePaths.push(tempPath);
  }

  // Compute hash of all content
  const combinedContent = allContent.join("\n---\n");
  const bundleHash = createHash("sha256")
    .update(combinedContent)
    .digest("hex")
    .slice(0, 16);

  // Skip if unchanged
  if (bundleHash === getLastBundleHash()) {
    return null;
  }

  // Create entry file that re-exports everything
  const entryContent = entryPoints
    .map((ep) => {
      const relativePath = "./" + basename(ep);
      return `export * from "${relativePath}";`;
    })
    .join("\n");

  const mainEntryPath = join(tempDir, "_sandbox_entry.ts");
  writeFileSync(mainEntryPath, entryContent);

  // Bundle with esbuild
  const bundleFilename = `bundle-${bundleHash}.js`;
  const bundlePath = join(outputDir, bundleFilename);

  try {
    buildSync({
      entryPoints: [mainEntryPath],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node18",
      outfile: bundlePath,
      minify: false,
      treeShaking: true,
      // Mark node builtins and frameworks as external
      external: [
        // Node.js built-ins
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
        "assert",
        "worker_threads",
        "cluster",
        "async_hooks",
        // Frameworks (not needed in sandbox)
        "next",
        "next/*",
        "react",
        "react-dom",
        "react/*",
        // Note: @use-sandbox/core IS bundled - it provides the $ helper
      ],
    });
  } catch (err) {
    console.error("[use-sandbox] Bundle failed:", err);
    throw err;
  }

  // Write manifest
  const manifest: BundleManifest = {
    hash: bundleHash,
    bundleFile: bundleFilename,
    generatedAt: new Date().toISOString(),
    sandboxFiles: allFilePaths,
  };

  const manifestPath = join(outputDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  setLastBundleHash(bundleHash);

  console.log(`[use-sandbox] Bundle ready: ${files.length} sandbox file(s)`);

  return {
    bundlePath,
    bundleHash,
    sandboxFiles: allFilePaths,
  };
}
