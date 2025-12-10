import { AsyncLocalStorage } from 'async_hooks';
import type { Sandbox } from '@vercel/sandbox';

/**
 * AsyncLocalStorage to maintain sandbox instance across "use exec" calls.
 * This allows nested exec calls to share the same sandbox session.
 */
export const sandboxContext = new AsyncLocalStorage<Sandbox>();

/**
 * Get the current sandbox instance from context.
 * Must be called within a "use sandbox" context.
 * 
 * @throws Error if called outside of a sandbox context
 */
export function getSandbox(): Sandbox {
  const sandbox = sandboxContext.getStore();
  if (!sandbox) {
    throw new Error(
      '"use exec" must be called within a "use sandbox" context. ' +
      'Make sure your exec function is called from within a function marked with "use sandbox".'
    );
  }
  return sandbox;
}

/**
 * Check if we're currently inside a sandbox context.
 */
export function hasSandboxContext(): boolean {
  return sandboxContext.getStore() !== undefined;
}

