/**
 * In-sandbox runner script.
 *
 * This script runs inside the Vercel Sandbox and is responsible for:
 * 1. Loading the bundle (pre-written to sandbox filesystem)
 * 2. Executing the requested function
 * 3. Returning the serialized result
 *
 * Usage:
 *   node runner.mjs <fnId> <argsJson>
 */

/**
 * Path where the bundle is written in the sandbox filesystem.
 */
export const SANDBOX_BUNDLE_PATH = "/tmp/sandbox-bundle.mjs";

/**
 * The runner script source code that gets written to the sandbox.
 * This is a self-contained ESM module.
 */
export const RUNNER_SCRIPT = `
async function run(fnId, args) {
  // Bundle is pre-written to the sandbox by the host
  const bundle = await import("/tmp/sandbox-bundle.mjs");

  const fn = bundle[fnId];
  if (!fn) {
    throw new Error("Function not found in bundle: " + fnId + ". Available: " + Object.keys(bundle).join(", "));
  }

  // Spread args array as positional arguments
  const result = await fn(...args);
  return result;
}

// Main execution
const [,, fnId, argsJson] = process.argv;

if (!fnId) {
  console.error(JSON.stringify({ __error: "Usage: node runner.mjs <fnId> <argsJson>" }));
  process.exit(1);
}

const args = argsJson ? JSON.parse(argsJson) : {};

run(fnId, args)
  .then(result => {
    console.log(JSON.stringify({ __result: result }));
  })
  .catch(err => {
    console.error(JSON.stringify({ __error: err.message, __stack: err.stack }));
    process.exit(1);
  });
`;

/**
 * Path where the runner script is written in the sandbox filesystem.
 */
export const RUNNER_SCRIPT_PATH = "/tmp/sandbox-runner.mjs";

