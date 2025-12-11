/**
 * Webpack/Turbopack loader for "use sandbox" directive transformation.
 *
 * This loader:
 * 1. Transforms "use sandbox" functions into server stubs
 * 2. Registers extracted function bodies
 * 3. Generates the bundle synchronously (so it's ready before requests)
 */

import { transform } from "./transformer";
import { generateBundleSync } from "./bundler";
import { hasRegisteredFunctions } from "./registry";

/**
 * Webpack/Turbopack loader for sandbox directive transformation
 */
export default async function sandboxLoader(
  source: string | Buffer
): Promise<string> {
  const normalizedSource = source.toString();

  // Skip if already transformed (prevents re-transformation in turbopack)
  if (normalizedSource.includes("__sandbox_runSandboxFn")) {
    return normalizedSource;
  }

  // Quick check - skip if no directive present
  if (!normalizedSource.includes("use sandbox")) {
    return normalizedSource;
  }

  // Get the resource path from webpack loader context
  // @ts-expect-error - this is available in webpack loader context
  const resourcePath: string = this?.resourcePath || "unknown.ts";

  try {
    const result = await transform(normalizedSource, resourcePath);

    // Generate bundle synchronously if we have sandbox functions
    if (result.hasSandboxFunctions && hasRegisteredFunctions()) {
      const bundleResult = generateBundleSync();
      if (bundleResult) {
        console.log(
          `[use-sandbox] Bundle ready: ${bundleResult.functionIds.length} functions`
        );
      }
    }

    return result.code;
  } catch (error) {
    // If transformation fails, log the error and return original source
    console.error(`[use-sandbox] Failed to transform ${resourcePath}:`, error);
    return normalizedSource;
  }
}
