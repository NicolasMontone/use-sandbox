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
 *
 * Protocol:
 *   node runner.mjs <fnId> <payloadJson>
 *
 * Payload format:
 *   { args: unknown[], closureVars?: Record<string, unknown> }
 *
 * If closureVars is present, it's passed as the first argument to the function.
 */
export const RUNNER_SCRIPT = `
async function run(fnId, payload) {
  const bundle = await import("/tmp/sandbox-bundle.mjs");

  const fn = bundle[fnId];
  if (!fn) {
    throw new Error("Function not found: " + fnId + ". Available: " + Object.keys(bundle).join(", "));
  }

  const { args = [], closureVars } = payload;

  // If closureVars exist, prepend them as first argument
  // The generated sandbox function expects: fn(__closure, ...originalArgs)
  const allArgs = closureVars ? [closureVars, ...args] : args;

  const result = await fn(...allArgs);
  return result;
}

const [,, fnId, payloadJson] = process.argv;

if (!fnId) {
  console.error(JSON.stringify({ __error: "Usage: node runner.mjs <fnId> <payloadJson>" }));
  process.exit(1);
}

const payload = payloadJson ? JSON.parse(payloadJson) : { args: [] };

run(fnId, payload)
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
