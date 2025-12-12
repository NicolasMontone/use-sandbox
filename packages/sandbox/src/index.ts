/**
 * @use-sandbox/core
 * 
 * Runtime for "use sandbox" directive with Vercel Sandbox.
 * 
 * @example
 * ```typescript
 * // Define a sandbox configuration
 * import { defineSandbox } from '@use-sandbox/core';
 * 
 * export const sandbox = defineSandbox({ vcpus: 4 });
 * 
 * // Define sandbox functions with the directive
 * async function readFile(path: string) {
 *   'use sandbox';
 *   const fs = await import('fs/promises');
 *   return fs.readFile(path, 'utf-8');
 * }
 * 
 * // Run with a key for pooling (args as array)
 * const content = await sandbox.run(sessionId, readFile, ['/tmp/test.txt']);
 * 
 * // Or with options
 * const content = await sandbox.run({ key: sessionId, sudo: false }, readFile, ['/tmp/test.txt']);
 * ```
 */

export { sandboxContext, getSandbox, getSandboxContext, hasSandboxContext, type SandboxContextValue } from './context.js';

export {
  // Main API
  defineSandbox,
  SandboxDefinition,
  
  // Internal (used by transformer)
  __runSandboxFn,
  
  // Types
  type SandboxConfig,
  type RunOptions,
  type RunSandboxFnOptions,
  
  // Legacy (deprecated)
  runInSandbox,
  sandboxConfig,
  type SandboxOptions,
} from './runtime.js';

// Shell utilities for safe command execution inside sandbox
export { $ } from './shell.js';
