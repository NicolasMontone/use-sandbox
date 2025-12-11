/**
 * Webpack/Turbopack loader for "use sandbox" directive transformation.
 *
 * This loader:
 * 1. Transforms "use sandbox" functions into server stubs
 * 2. Generates .sandbox.ts content for each file
 * 3. Bundles all sandbox functions for execution in the sandbox
 */

import { transform } from "./transformer";
import {
  registerSandboxFile,
  generateBundleSync,
  hasSandboxFiles,
} from "./bundler";

/**
 * Webpack/Turbopack loader for sandbox directive transformation
 */
export default async function sandboxLoader(
  source: string | Buffer
): Promise<string> {
  const normalizedSource = source.toString();

  // Skip if already transformed
  if (normalizedSource.includes("__sandbox_runSandboxFn")) {
    return normalizedSource;
  }

  // Quick check - skip if no directive present
  if (!normalizedSource.includes("use sandbox")) {
    return normalizedSource;
  }

  // @ts-expect-error - webpack loader context
  const resourcePath: string = this?.resourcePath || "unknown.ts";

  // Skip .sandbox.ts files (we generate these)
  if (resourcePath.includes(".sandbox.")) {
    return normalizedSource;
  }

  try {
    const result = await transform(normalizedSource, resourcePath);

    if (result.hasSandboxFunctions && result.sandboxFileContent) {
      // Register the sandbox file for bundling
      registerSandboxFile(result.sandboxFilePath!, result.sandboxFileContent);

      // Generate bundle if we have files
      if (hasSandboxFiles()) {
        generateBundleSync();
      }
    }

    return result.code;
  } catch (error) {
    console.error(`[use-sandbox] Transform failed for ${resourcePath}:`, error);
    return normalizedSource;
  }
}
