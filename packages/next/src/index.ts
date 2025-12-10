import type { NextConfig } from 'next';

/**
 * Wrap your Next.js config with withSandbox to enable "use sandbox" and "use exec" directives.
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
    const loaderPath = require.resolve('./loader');

    let nextConfig: NextConfig;

    if (typeof nextConfigOrFn === 'function') {
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
    
    const existingRules = nextConfig.turbopack.rules as Record<string, any>;

    for (const key of [
      '*.tsx',
      '*.ts',
      '*.jsx',
      '*.js',
      '*.mjs',
      '*.mts',
      '*.cjs',
      '*.cts',
    ]) {
      nextConfig.turbopack.rules[key] = {
        loaders: [...(existingRules[key]?.loaders || []), loaderPath],
      };
    }

    // configure the loader for webpack
    const existingWebpackModify = nextConfig.webpack;
    nextConfig.webpack = (...args) => {
      const [webpackConfig] = args;
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

      return existingWebpackModify
        ? existingWebpackModify(...args)
        : webpackConfig;
    };

    return nextConfig;
  };
}

