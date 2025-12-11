/**
 * In-sandbox runner script.
 *
 * This script runs inside the Vercel Sandbox and is responsible for:
 * 1. Fetching the bundle from the server (with caching)
 * 2. Loading and executing the requested function
 * 3. Returning the serialized result
 *
 * Usage:
 *   node runner.mjs <bundleUrl> <fnId> <argsJson>
 */

// Constants used in the runner script below

/**
 * The runner script source code that gets written to the sandbox.
 * This is a self-contained ESM module.
 */
export const RUNNER_SCRIPT = `
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';

const CACHE_DIR = "/tmp/sandbox-bundles";
const BUNDLE_CACHE_FILE = CACHE_DIR + "/bundle.mjs";

let cachedBundle = null;
let cachedBundleUrl = null;

async function ensureDir(dir) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function fetchBundle(bundleUrl) {
  // If we already have the bundle cached in memory for this URL, use it
  if (cachedBundle && cachedBundleUrl === bundleUrl) {
    return cachedBundle;
  }

  // Check filesystem cache
  if (existsSync(BUNDLE_CACHE_FILE)) {
    try {
      const cached = await readFile(BUNDLE_CACHE_FILE + ".url", "utf-8");
      if (cached === bundleUrl) {
        cachedBundle = await import(BUNDLE_CACHE_FILE);
        cachedBundleUrl = bundleUrl;
        return cachedBundle;
      }
    } catch {
      // Cache miss, fetch fresh
    }
  }

  // Fetch the bundle
  const response = await fetch(bundleUrl);
  if (!response.ok) {
    throw new Error("Failed to fetch bundle: " + response.status + " " + response.statusText);
  }

  const bundleCode = await response.text();

  // Write to cache
  await ensureDir(CACHE_DIR);
  await writeFile(BUNDLE_CACHE_FILE, bundleCode);
  await writeFile(BUNDLE_CACHE_FILE + ".url", bundleUrl);

  // Import the bundle
  cachedBundle = await import(BUNDLE_CACHE_FILE);
  cachedBundleUrl = bundleUrl;

  return cachedBundle;
}

async function run(bundleUrl, fnId, args) {
  const bundle = await fetchBundle(bundleUrl);

  const fn = bundle[fnId];
  if (!fn) {
    throw new Error("Function not found in bundle: " + fnId);
  }

  const result = await fn(args);
  return result;
}

// Main execution
const [,, bundleUrl, fnId, argsJson] = process.argv;

if (!bundleUrl || !fnId) {
  console.error(JSON.stringify({ __error: "Usage: node runner.mjs <bundleUrl> <fnId> <argsJson>" }));
  process.exit(1);
}

const args = argsJson ? JSON.parse(argsJson) : {};

run(bundleUrl, fnId, args)
  .then(result => {
    console.log(JSON.stringify({ __result: result }));
  })
  .catch(err => {
    console.error(JSON.stringify({ __error: err.message, __stack: err.stack }));
    process.exit(1);
  });
`;

/**
 * Get the runner script path in the sandbox filesystem.
 */
export const RUNNER_SCRIPT_PATH = "/tmp/sandbox-runner.mjs";

