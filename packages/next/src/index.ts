import type { NextConfig } from "next";
import { generateBundle, getBundleUrl } from "./bundler";
import { hasRegisteredFunctions, clearRegistry } from "./registry";
import type { Compiler, Compilation } from "webpack";

/**
 * Wrap your Next.js config with withSandbox to enable "use sandbox" directive.
 *
 * @example
 * ```typescript
 * // next.config.ts
 * import { withSandbox } from '@use-sandbox/next';
 *
 * export default withSandbox({
 *   // your next config
 * });
 * ```
 */
export function withSandbox(
  nextConfigOrFn:
    | NextConfig
    | ((
        phase: string,
        ctx: { defaultConfig: NextConfig }
      ) => Promise<NextConfig>)
) {
  return async function buildConfig(
    phase: string,
    ctx: { defaultConfig: NextConfig }
  ) {
    const loaderPath = require.resolve("./loader");

    let nextConfig: NextConfig;

    if (typeof nextConfigOrFn === "function") {
      nextConfig = await nextConfigOrFn(phase, ctx);
    } else {
      nextConfig = nextConfigOrFn;
    }

    // shallow clone to avoid read-only on top-level
    nextConfig = Object.assign({}, nextConfig);

    // configure the loader if turbopack is being used
    if (!nextConfig.turbopack) {
      nextConfig.turbopack = {};
    }
    if (!nextConfig.turbopack.rules) {
      nextConfig.turbopack.rules = {};
    }

    const existingRules = nextConfig.turbopack.rules as Record<string, unknown>;

    for (const key of [
      "*.tsx",
      "*.ts",
      "*.jsx",
      "*.js",
      "*.mjs",
      "*.mts",
      "*.cjs",
      "*.cts",
    ]) {
      nextConfig.turbopack.rules[key] = {
        loaders: [
          ...((existingRules[key] as { loaders?: string[] })?.loaders || []),
          loaderPath,
        ],
      };
    }

    // configure the loader for webpack
    const existingWebpackModify = nextConfig.webpack;
    nextConfig.webpack = (webpackConfig, options) => {
      if (!webpackConfig.module) {
        webpackConfig.module = {};
      }
      if (!webpackConfig.module.rules) {
        webpackConfig.module.rules = [];
      }

      // loaders in webpack apply bottom->up so ensure
      // ours comes before the default swc transform
      webpackConfig.module.rules.push({
        test: /.*\.(mjs|cjs|cts|ts|tsx|js|jsx)$/,
        loader: loaderPath,
      });

      // Add our bundle generation plugin
      if (!options.isServer) {
        // Only run on client build to avoid duplicate bundling
        webpackConfig.plugins = webpackConfig.plugins || [];
        webpackConfig.plugins.push(new SandboxBundlePlugin());
      }

      return existingWebpackModify
        ? existingWebpackModify(webpackConfig, options)
        : webpackConfig;
    };

    return nextConfig;
  };
}

/**
 * Webpack plugin that generates the sandbox bundle after compilation.
 */
class SandboxBundlePlugin {
  apply(compiler: Compiler) {
    const pluginName = "SandboxBundlePlugin";

    compiler.hooks.afterEmit.tapAsync(
      pluginName,
      async (compilation: Compilation, callback: (err?: Error) => void) => {
        if (!hasRegisteredFunctions()) {
          callback();
          return;
        }

        try {
          const outputPath = compilation.outputOptions.path || ".next";
          const result = await generateBundle(outputPath);

          if (result) {
            console.log(
              `[use-sandbox] Generated bundle with ${result.functionIds.length} functions: ${result.bundlePath}`
            );

            // Store the bundle URL for runtime use
            const bundleUrl = getBundleUrl(result.bundleHash);
            process.env.__SANDBOX_BUNDLE_URL = bundleUrl;
            process.env.__SANDBOX_BUNDLE_HASH = result.bundleHash;
          }

          // Clear registry after bundling to avoid duplicate entries on rebuild
          clearRegistry();

          callback();
        } catch (error) {
          console.error("[use-sandbox] Failed to generate bundle:", error);
          callback(error as Error);
        }
      }
    );
  }
}
