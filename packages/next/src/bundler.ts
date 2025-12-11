/**
 * Bundler V2: Clean bundling of .sandbox.ts files.
 *
 * Simply collects all generated .sandbox.ts files and bundles them with esbuild.
 * No regex parsing, no manual import extraction - just let esbuild do its job.
 */

import { buildSync } from "esbuild";
import { writeFileSync, mkdirSync, existsSync } from "fs";
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
// State
// ============================================================================

// Track generated sandbox files
const sandboxFiles = new Map<string, string>(); // path -> content

// Track last bundle hash to avoid re-bundling
let lastBundleHash: string | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a sandbox file for bundling.
 * Called by the loader after transformation.
 */
export function registerSandboxFile(filePath: string, content: string): void {
  sandboxFiles.set(filePath, content);
}

/**
 * Clear all registered sandbox files.
 */
export function clearSandboxFiles(): void {
  sandboxFiles.clear();
  lastBundleHash = null;
}

/**
 * Check if there are any sandbox files to bundle.
 */
export function hasSandboxFiles(): boolean {
  return sandboxFiles.size > 0;
}

/**
 * Get all registered sandbox files.
 */
export function getSandboxFiles(): Map<string, string> {
  return new Map(sandboxFiles);
}

/**
 * Generate the sandbox bundle synchronously.
 * Returns null if no files or bundle is already up-to-date.
 */
export function generateBundleSync(): BundleResult | null {
  if (sandboxFiles.size === 0) {
    return null;
  }

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

  // Write sandbox files to temp directory
  const entryPoints: string[] = [];
  const allContent: string[] = [];

  for (const [filePath, content] of sandboxFiles) {
    // Create a unique filename in temp dir
    const safeName = filePath
      .replace(projectRoot, "")
      .replace(/[/\\]/g, "__")
      .replace(/^__/, "");
    const tempPath = join(tempDir, safeName);

    writeFileSync(tempPath, content);
    entryPoints.push(tempPath);
    allContent.push(content);
  }

  // Compute hash of all content
  const combinedContent = allContent.join("\n---\n");
  const bundleHash = createHash("sha256")
    .update(combinedContent)
    .digest("hex")
    .slice(0, 16);

  // Skip if unchanged
  if (bundleHash === lastBundleHash) {
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
      minify: true,
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
    sandboxFiles: Array.from(sandboxFiles.keys()),
  };

  const manifestPath = join(outputDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  lastBundleHash = bundleHash;

  console.log(
    `[use-sandbox] Bundle ready: ${sandboxFiles.size} sandbox file(s)`
  );

  return {
    bundlePath,
    bundleHash,
    sandboxFiles: Array.from(sandboxFiles.keys()),
  };
}
