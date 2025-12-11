/**
 * esbuild-based bundler for sandbox functions.
 *
 * Reads original source files to extract imports and function definitions,
 * then bundles everything together with esbuild.
 */

import { buildSync } from "esbuild";
import { getRegisteredFunctions, hasRegisteredFunctions } from "./registry";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
export interface BundleResult {
  bundlePath: string;
  bundleHash: string;
  functionIds: string[];
}

// Track the last generated bundle hash to avoid regenerating
let lastBundleHash: string | null = null;

/**
 * Generate the sandbox bundle synchronously.
 * Returns null if no functions are registered or bundle is already up-to-date.
 */
export function generateBundleSync(): BundleResult | null {
  if (!hasRegisteredFunctions()) {
    return null;
  }

  const functions = getRegisteredFunctions();

  // We need to handle async extraction, so we'll do it slightly differently
  // For now, use a simpler approach: read files synchronously and use regex
  
  const entryParts: string[] = [];
  const seenImports = new Set<string>();

  for (const fn of functions) {
    const source = readFileSync(fn.sourceFile, "utf-8");
    
    // Extract all imports (simple regex approach)
    const importMatches = source.matchAll(/^import\s+.*?(?:from\s+['"][^'"]+['"])?;?\s*$/gm);
    for (const match of importMatches) {
      if (!seenImports.has(match[0])) {
        seenImports.add(match[0]);
        entryParts.push(match[0]);
      }
    }
  }

  // Add a separator
  entryParts.push("\n// Sandbox functions\n");

  for (const fn of functions) {
    const source = readFileSync(fn.sourceFile, "utf-8");
    
    // Find the function definition using regex
    // Match: async function fnName(...) { ... }
    // This is a simplified approach - handles common cases
    const fnRegex = new RegExp(
      `(async\\s+)?function\\s+${fn.fnName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\s*\\{`,
      "g"
    );
    
    const match = fnRegex.exec(source);
    if (match) {
      // Find the matching closing brace
      const startIndex = match.index;
      let braceCount = 0;
      let endIndex = startIndex;
      let inString = false;
      let stringChar = "";
      
      for (let i = startIndex; i < source.length; i++) {
        const char = source[i];
        const prevChar = i > 0 ? source[i - 1] : "";
        
        // Handle strings
        if ((char === '"' || char === "'" || char === "`") && prevChar !== "\\") {
          if (!inString) {
            inString = true;
            stringChar = char;
          } else if (char === stringChar) {
            inString = false;
          }
        }
        
        if (!inString) {
          if (char === "{") braceCount++;
          if (char === "}") {
            braceCount--;
            if (braceCount === 0) {
              endIndex = i + 1;
              break;
            }
          }
        }
      }
      
      let fnCode = source.slice(startIndex, endIndex);
      
      // Rename and export
      fnCode = fnCode.replace(
        new RegExp(`(async\\s+)?function\\s+${fn.fnName}`),
        `export $1function ${fn.fnId}`
      );
      
      entryParts.push(fnCode);
    }
  }

  const entryContent = entryParts.join("\n\n");

  // Generate hash for cache busting
  const bundleHash = createHash("sha256")
    .update(entryContent)
    .digest("hex")
    .slice(0, 16);

  // Skip if bundle is already up-to-date
  if (lastBundleHash === bundleHash) {
    return null;
  }

  // Always write to a predictable location relative to cwd
  const projectRoot = process.cwd();
  const sandboxDir = join(projectRoot, ".next/static/sandbox");

  // Create a temporary entry file
  const tempDir = join(projectRoot, ".next/.sandbox-temp");
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  const entryPath = join(tempDir, "sandbox-entry.ts");
  writeFileSync(entryPath, entryContent);

  // Ensure output directory exists
  if (!existsSync(sandboxDir)) {
    mkdirSync(sandboxDir, { recursive: true });
  }

  const bundleFilename = `bundle-${bundleHash}.js`;
  const bundlePath = join(sandboxDir, bundleFilename);

  // Bundle with esbuild (synchronous)
  buildSync({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    outfile: bundlePath,
    minify: false, // Keep readable for debugging
    treeShaking: true,
    // External: node builtins + frameworks that shouldn't be in sandbox
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
      // Frameworks (shouldn't be in sandbox)
      "next",
      "next/*",
      "react",
      "react-dom",
      "react/*",
    ],
  });

  // Also write a manifest file
  const manifest = {
    hash: bundleHash,
    bundleFile: bundleFilename,
    functions: functions.map((fn) => ({
      id: fn.fnId,
      originalName: fn.fnName,
      sourceFile: fn.sourceFile,
    })),
  };

  const manifestPath = join(sandboxDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Remember the hash to avoid regenerating
  lastBundleHash = bundleHash;

  return {
    bundlePath,
    bundleHash,
    functionIds: functions.map((fn) => fn.fnId),
  };
}

/**
 * Async version for compatibility.
 * @deprecated Use generateBundleSync instead
 */
export async function generateBundle(_outputDir: string): Promise<BundleResult | null> {
  return generateBundleSync();
}
