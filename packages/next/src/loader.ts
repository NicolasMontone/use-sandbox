/**
 * Webpack/Turbopack loader for "use sandbox" directive transformation.
 *
 * This loader uses the AST transformer to:
 * 1. Transform "use sandbox" functions into server stubs
 * 2. Register extracted function bodies for bundling
 */

import { transform } from "./transformer";

/**
 * Webpack/Turbopack loader for sandbox directive transformation
 */
export default async function sandboxLoader(
  source: string | Buffer
): Promise<string> {
  const normalizedSource = source.toString();

  // Quick check - skip if no directive present
  if (!normalizedSource.includes("use sandbox")) {
    return normalizedSource;
  }

  // Get the resource path from webpack loader context
  // @ts-expect-error - this is available in webpack loader context
  const resourcePath: string = this?.resourcePath || "unknown.ts";

  try {
    const result = await transform(normalizedSource, resourcePath);
    return result.code;
  } catch (error) {
    // If transformation fails, log the error and return original source
    console.error(`[use-sandbox] Failed to transform ${resourcePath}:`, error);
    return normalizedSource;
  }
}
