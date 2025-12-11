/**
 * @use-sandbox/core
 * 
 * Runtime for "use sandbox" and "use exec" directives with Vercel Sandbox.
 * 
 * @example
 * ```typescript
 * // Mark a function to run in sandbox context
 * async function agent() {
 *   'use sandbox';
 *   const content = await readFile('/tmp/test.txt');
 *   return content;
 * }
 * 
 * // Mark a function to execute inside the sandbox
 * async function readFile(path: string) {
 *   'use exec';
 *   const fs = await import('fs/promises');
 *   return fs.readFile(path, 'utf-8');
 * }
 * ```
 */

export { sandboxContext, getSandbox, hasSandboxContext } from './context.js';

export {
  runInSandbox,
  execInSandbox,
  runCommand,
  readFile,
  writeFile,
  __runSandboxFn,
  sandboxConfig,
  type SandboxOptions,
  type SandboxConfig,
  type RunSandboxFnOptions,
} from './runtime.js';

