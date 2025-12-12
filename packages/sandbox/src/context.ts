import { AsyncLocalStorage } from 'async_hooks';
import type { Sandbox } from '@vercel/sandbox';

/**
 * Context stored in AsyncLocalStorage during sandbox execution.
 */
export interface SandboxContextValue {
  sandbox: Sandbox;
  sudo: boolean;
}

/**
 * AsyncLocalStorage to maintain sandbox instance across "use exec" calls.
 * This allows nested exec calls to share the same sandbox session.
 */
export const sandboxContext = new AsyncLocalStorage<SandboxContextValue>();

/**
 * Get the current sandbox context.
 * Must be called within a "use sandbox" context.
 * 
 * @throws Error if called outside of a sandbox context
 */
export function getSandboxContext(): SandboxContextValue {
  const ctx = sandboxContext.getStore();
  if (!ctx) {
    throw new Error(
      '"use exec" must be called within a "use sandbox" context. ' +
      'Make sure your exec function is called from within a function marked with "use sandbox".'
    );
  }
  return ctx;
}

/**
 * Get the current sandbox instance from context.
 * Must be called within a "use sandbox" context.
 * 
 * @throws Error if called outside of a sandbox context
 */
export function getSandbox(): Sandbox {
  return getSandboxContext().sandbox;
}

/**
 * Check if we're currently inside a sandbox context.
 */
export function hasSandboxContext(): boolean {
  return sandboxContext.getStore() !== undefined;
}

