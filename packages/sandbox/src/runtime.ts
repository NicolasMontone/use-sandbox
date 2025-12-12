import { Sandbox } from "@vercel/sandbox";
import { sandboxContext, hasSandboxContext } from "./context.js";
import {
  RUNNER_SCRIPT,
  RUNNER_SCRIPT_PATH,
  SANDBOX_BUNDLE_PATH,
} from "./runner.js";
import { readFileSync } from "fs";
import { join } from "path";

// ============================================================================
// Sandbox Configuration
// ============================================================================

type CreateSandboxParams = NonNullable<Parameters<typeof Sandbox.create>[0]>;

export type SandboxConfig = Pick<
  CreateSandboxParams,
  "resources" | "timeout" | "source" | "runtime"
>;

/**
 * Options for a single sandbox.run() call.
 */
export interface RunOptions {
  /**
   * Unique key for sandbox pooling.
   */
  key: string;

  /**
   * Run command with root privileges.
   * @default true
   */
  sudo?: boolean;
}

// ============================================================================
// defineSandbox - Create a sandbox definition with pooling
// ============================================================================

/**
 * Define a sandbox configuration for running sandbox functions.
 *
 * @example
 * ```typescript
 * // Define once
 * export const sandbox = defineSandbox({ vcpus: 4, memory: 512 });
 *
 * // Use with a key for pooling
 * await sandbox.run(sessionId, myFunction, arg1, arg2);
 * ```
 */
export function defineSandbox(config: SandboxConfig = {}): SandboxDefinition {
  return new SandboxDefinition(config);
}

// Global sandbox pool that survives hot-reload in dev mode.
// Using a symbol key to avoid conflicts with other code.
const GLOBAL_POOL_KEY = Symbol.for("@use-sandbox/pool");

function getGlobalPool(): Map<string, Sandbox> {
  const g = globalThis as Record<symbol, Map<string, Sandbox>>;
  if (!g[GLOBAL_POOL_KEY]) {
    g[GLOBAL_POOL_KEY] = new Map();
  }
  return g[GLOBAL_POOL_KEY];
}

/**
 * A sandbox definition that manages a pool of sandboxes by key.
 */
export class SandboxDefinition {
  private config: SandboxConfig;

  constructor(config: SandboxConfig) {
    this.config = config;
  }

  /**
   * Get the global pool (survives hot-reload).
   */
  private get pool(): Map<string, Sandbox> {
    return getGlobalPool();
  }

  /**
   * Run a sandbox function with the given key.
   *
   * Same key = same sandbox (pooled and reused).
   * Different key = different sandbox.
   *
   * @param keyOrOptions - Unique key for sandbox pooling, or options object
   * @param fn - The sandbox function to run
   * @param args - Arguments to pass to the function (as array)
   *
   * @example
   * ```typescript
   * // Simple: just a key
   * await sandbox.run(sessionId, myFn, [arg1, arg2]);
   *
   * // With options
   * await sandbox.run({ key: sessionId, sudo: false }, myFn, [arg1, arg2]);
   * ```
   */
  async run<T, Args extends unknown[]>(
    keyOrOptions: string | RunOptions,
    fn: (...args: Args) => Promise<T>,
    args: Args
  ): Promise<T> {
    const { key, sudo } =
      typeof keyOrOptions === "string"
        ? { key: keyOrOptions, sudo: true }
        : { key: keyOrOptions.key, sudo: keyOrOptions.sudo ?? true };

    // Get or create sandbox for this key
    let sandbox = this.pool.get(key);

    if (!sandbox) {
      sandbox = await Sandbox.create({
        timeout: 300_000,
        ...this.config,
      });
      this.pool.set(key, sandbox);
    }

    // Always ensure runner and bundle are up-to-date (checks hash on every use)
    await ensureSandboxReady(sandbox, key);

    // Run the function with this sandbox in context (including sudo option)
    return sandboxContext.run({ sandbox, sudo }, () => fn(...args));
  }

  /**
   * Stop and remove a sandbox by key.
   */
  async stop(key: string): Promise<void> {
    const sandbox = this.pool.get(key);
    if (sandbox) {
      await sandbox.stop();
      this.pool.delete(key);
    }
  }

  /**
   * Stop all sandboxes in the pool.
   */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.pool.entries()).map(
      async ([key, sandbox]) => {
        await sandbox.stop();
        this.pool.delete(key);
      }
    );
    await Promise.all(promises);
  }

  /**
   * Get the number of active sandboxes in the pool.
   */
  get size(): number {
    return this.pool.size;
  }
}

// ============================================================================
// Bundle and Runner Management
// ============================================================================

// Cache for bundle content (read once from disk)
let cachedBundleContent: string | null = null;
let cachedBundleHash: string | null = null;

import { getStorage } from "./storage.js";

// Track if runner is installed in each sandbox (in-memory, per-process)
// This is okay to lose on process restart since runner script is static
const RUNNER_INSTALLED_KEY = Symbol.for("@use-sandbox/runner-installed");

type RunnerInstalledMap = WeakMap<Sandbox, boolean>;

function getRunnerInstalledMap(): RunnerInstalledMap {
  const g = globalThis as Record<symbol, RunnerInstalledMap>;
  if (!g[RUNNER_INSTALLED_KEY]) {
    g[RUNNER_INSTALLED_KEY] = new WeakMap();
  }
  return g[RUNNER_INSTALLED_KEY];
}

interface BundleManifest {
  hash: string;
  bundleFile: string;
  functions: Array<{ id: string; sourceFile: string }>;
}

/**
 * Read the bundle content from disk.
 * In development, always re-reads to pick up changes.
 * In production, caches the result for performance.
 */
function getBundleContent(): { content: string; hash: string } {
  const isDev = process.env.NODE_ENV !== "production";

  // In production, use cached content if available
  if (!isDev && cachedBundleContent && cachedBundleHash) {
    return { content: cachedBundleContent, hash: cachedBundleHash };
  }

  const manifestPath = join(
    process.cwd(),
    ".next/static/sandbox/manifest.json"
  );

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to read sandbox manifest at ${manifestPath}. ` +
        `Make sure you've built your app with the withSandbox() plugin configured. ` +
        `Error: ${(err as Error).message}`
    );
  }

  const bundlePath = join(
    process.cwd(),
    ".next/static/sandbox",
    manifest.bundleFile
  );

  try {
    cachedBundleContent = readFileSync(bundlePath, "utf-8");
    cachedBundleHash = manifest.hash;
  } catch (err) {
    throw new Error(
      `Failed to read sandbox bundle at ${bundlePath}. ` +
        `Error: ${(err as Error).message}`
    );
  }

  return { content: cachedBundleContent, hash: cachedBundleHash };
}

/**
 * Ensure the runner script and bundle are installed in the sandbox.
 */
async function ensureSandboxReady(
  sandbox: Sandbox,
  sandboxKey: string
): Promise<void> {
  const runnerMap = getRunnerInstalledMap();
  const runnerInstalled = runnerMap.get(sandbox) ?? false;

  // Use storage for bundle hash (persists across processes)
  const storage = getStorage();
  const installedHash = storage.getInstalledHash(sandboxKey);

  const { content: bundleContent, hash: bundleHash } = getBundleContent();

  const filesToWrite: Array<{ path: string; content: Buffer }> = [];

  // Add runner if not installed (in-memory check is fine, runner is static)
  if (!runnerInstalled) {
    filesToWrite.push({
      path: RUNNER_SCRIPT_PATH,
      content: Buffer.from(RUNNER_SCRIPT, "utf-8"),
    });
  }

  // Add bundle if not installed or hash changed (uses persistent storage)
  if (installedHash !== bundleHash) {
    filesToWrite.push({
      path: SANDBOX_BUNDLE_PATH,
      content: Buffer.from(bundleContent, "utf-8"),
    });
  }

  if (filesToWrite.length > 0) {
    await sandbox.writeFiles(filesToWrite);
    runnerMap.set(sandbox, true);
    storage.setInstalledHash(sandboxKey, bundleHash);

    // Log when bundle is updated (helpful for debugging hot-reload)
    const isDev = process.env.NODE_ENV !== "production";
    if (isDev && installedHash !== null) {
      console.log(
        `[use-sandbox] Bundle updated in sandbox (${installedHash?.slice(0, 8)} -> ${bundleHash.slice(0, 8)})`
      );
    }
  }
}

// ============================================================================
// __runSandboxFn - Called by transformed "use sandbox" functions
// ============================================================================

export interface RunSandboxFnOptions {
  fnId: string;
  config?: SandboxConfig;
  args: unknown[];
  /** Closure variables for nested sandbox functions */
  closureVars?: Record<string, unknown>;
}

/**
 * Internal function called by transformed "use sandbox" functions.
 *
 * If called within a sandbox.run() context, uses that sandbox.
 * Otherwise, creates an ephemeral sandbox for this call.
 */
export async function __runSandboxFn<T>(
  options: RunSandboxFnOptions
): Promise<T> {
  const { fnId, config = {}, args, closureVars } = options;

  // Check if we're already in a sandbox context (from sandbox.run)
  const ctx = sandboxContext.getStore();

  if (ctx) {
    // Use the existing sandbox and sudo setting from context
    return executeInSandbox(ctx.sandbox, fnId, args, closureVars, ctx.sudo);
  }

  // No context - create an ephemeral sandbox for this call
  const sandbox = await Sandbox.create({
    timeout: 300_000,
    ...config,
  });

  try {
    // Ephemeral sandboxes use a unique key (won't persist, but that's fine)
    const ephemeralKey = `ephemeral-${Date.now()}`;
    await ensureSandboxReady(sandbox, ephemeralKey);
    return await executeInSandbox(sandbox, fnId, args, closureVars);
  } finally {
    await sandbox.stop();
  }
}

/**
 * Execute a function in the given sandbox.
 */
async function executeInSandbox<T>(
  sandbox: Sandbox,
  fnId: string,
  args: unknown[],
  closureVars?: Record<string, unknown>,
  sudo: boolean = true
): Promise<T> {
  // Build payload for runner
  const payload: { args: unknown[]; closureVars?: Record<string, unknown> } = {
    args,
  };
  if (closureVars) {
    payload.closureVars = closureVars;
  }

  const payloadJson = JSON.stringify(payload);
  const result = await sandbox.runCommand({
    cmd: "node",
    args: [RUNNER_SCRIPT_PATH, fnId, payloadJson],
    sudo,
  });

  const stdout = await result.stdout();
  const stderr = await result.stderr();

  // Parse the result
  try {
    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const parsed = JSON.parse(lastLine);

    if (parsed.__error) {
      const error = new Error(parsed.__error);
      if (parsed.__stack) {
        error.stack = parsed.__stack;
      }
      throw error;
    }

    return parsed.__result as T;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(
        `Sandbox execution failed.\nstdout: ${stdout}\nstderr: ${stderr}`
      );
    }
    throw e;
  }
}

// ============================================================================
// Legacy APIs (for backward compatibility)
// ============================================================================

export interface SandboxOptions {
  timeout?: number;
}

/**
 * @deprecated Use defineSandbox() instead
 */
export async function runInSandbox<T>(
  fn: () => Promise<T>,
  options?: SandboxOptions
): Promise<T> {
  if (hasSandboxContext()) {
    return fn();
  }

  const sandbox = await Sandbox.create({
    timeout: options?.timeout ?? 300_000,
  });

  try {
    return await sandboxContext.run({ sandbox, sudo: true }, fn);
  } finally {
    await sandbox.stop();
  }
}

/**
 * sandboxConfig is a marker function used in "use sandbox" functions
 * to configure sandbox options. It's extracted at build time.
 *
 * @deprecated With defineSandbox(), config is passed to defineSandbox() instead
 */
export function sandboxConfig(_config: SandboxConfig): void {
  // This function is a no-op at runtime.
  // Config is now passed to defineSandbox() instead.
}
