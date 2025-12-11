import { Sandbox } from "@vercel/sandbox";
import { sandboxContext, hasSandboxContext } from "./context.js";
import { RUNNER_SCRIPT, RUNNER_SCRIPT_PATH } from "./runner.js";

export interface SandboxOptions {
  /**
   * Timeout in milliseconds for the sandbox session.
   * @default 300000 (5 minutes)
   */
  timeout?: number;
}

/**
 * Run a function within a Vercel Sandbox context.
 * Creates a new sandbox, executes the function, and stops the sandbox when done.
 *
 * All "use exec" calls within the function will use this sandbox instance.
 *
 * @param fn - The async function to run within the sandbox context
 * @param options - Optional configuration for the sandbox
 * @returns The result of the function
 */
export async function runInSandbox<T>(
  fn: () => Promise<T>,
  options?: SandboxOptions
): Promise<T> {
  // If we're already in a sandbox context, just run the function
  // This supports nested "use sandbox" calls without creating extra sandboxes
  if (hasSandboxContext()) {
    return fn();
  }

  const sandbox = await Sandbox.create({
    timeout: options?.timeout ?? 300_000, // 5 minutes default
  });

  try {
    return await sandboxContext.run(sandbox, fn);
  } finally {
    await sandbox.stop();
  }
}

/**
 * Execute JavaScript code inside the current sandbox using Node.js.
 * Must be called within a "use sandbox" context.
 *
 * This is the runtime function that "use exec" directives are transformed to use.
 *
 * @param code - The JavaScript code string to execute in the sandbox
 * @param args - Arguments to pass to the code (available as __args)
 * @returns The result of the execution
 */
export async function execInSandbox<T>(
  code: string,
  args?: Record<string, unknown>
): Promise<T> {
  const sandbox = sandboxContext.getStore();
  if (!sandbox) {
    throw new Error(
      '"use exec" must be called within a "use sandbox" context. ' +
        "Make sure your exec function is called from within a function marked with \"use sandbox\"."
    );
  }

  // Wrap the code to handle args and return value
  const wrappedCode = `
const __args = ${JSON.stringify(args ?? {})};
(async () => {
  ${code}
})().then(result => {
  console.log(JSON.stringify({ __result: result }));
}).catch(err => {
  console.error(JSON.stringify({ __error: err.message }));
  process.exit(1);
});
`;

  // Write the code to a temp file and execute it
  const tempFile = `/tmp/exec_${Date.now()}.mjs`;
  await sandbox.writeFiles([
    { path: tempFile, content: Buffer.from(wrappedCode, "utf-8") },
  ]);

  const result = await sandbox.runCommand("node", [tempFile]);
  const stdout = await result.stdout();

  // Parse the result
  try {
    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const parsed = JSON.parse(lastLine);

    if (parsed.__error) {
      throw new Error(parsed.__error);
    }

    return parsed.__result as T;
  } catch (e) {
    // If we can't parse, return the raw stdout
    return stdout as unknown as T;
  }
}

/**
 * Run a shell command in the current sandbox.
 * Must be called within a "use sandbox" context.
 *
 * @param cmd - The command to run
 * @param args - Arguments for the command
 * @returns The command result with stdout/stderr
 */
export async function runCommand(
  cmd: string,
  args?: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const sandbox = sandboxContext.getStore();
  if (!sandbox) {
    throw new Error(
      'runCommand must be called within a "use sandbox" context.'
    );
  }

  const result = await sandbox.runCommand(cmd, args);

  return {
    stdout: await result.stdout(),
    stderr: await result.stderr(),
    exitCode: result.exitCode,
  };
}

/**
 * Read a file from the sandbox filesystem.
 * Must be called within a "use sandbox" context.
 */
export async function readFile(path: string): Promise<string> {
  const sandbox = sandboxContext.getStore();
  if (!sandbox) {
    throw new Error('readFile must be called within a "use sandbox" context.');
  }

  const stream = await sandbox.readFile({ path });
  if (!stream) {
    throw new Error(`File not found: ${path}`);
  }

  // Read the stream into a string
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Write a file to the sandbox filesystem.
 * Must be called within a "use sandbox" context.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  const sandbox = sandboxContext.getStore();
  if (!sandbox) {
    throw new Error('writeFile must be called within a "use sandbox" context.');
  }

  await sandbox.writeFiles([{ path, content: Buffer.from(content, "utf-8") }]);
}

// ============================================================================
// New "use sandbox" directive runtime
// ============================================================================

export interface SandboxConfig {
  /**
   * Unique key for sandbox pooling. Sandboxes with the same key may be reused.
   */
  key?: string;

  /**
   * Number of vCPUs for the sandbox.
   */
  vcpus?: number;

  /**
   * Memory in MB for the sandbox.
   */
  memory?: number;

  /**
   * Timeout in milliseconds.
   */
  timeout?: number;
}

export interface RunSandboxFnOptions {
  fnId: string;
  config: SandboxConfig;
  args: Record<string, unknown>;
}

// Track sandboxes with runner script installed
const sandboxesWithRunner = new WeakSet<Sandbox>();

/**
 * Get the bundle URL from environment or compute it.
 */
function getBundleUrl(): string {
  // Check for build-time injected URL
  if (process.env.__SANDBOX_BUNDLE_URL) {
    return process.env.__SANDBOX_BUNDLE_URL;
  }

  // Compute based on Vercel environment
  const hash = process.env.__SANDBOX_BUNDLE_HASH || "latest";
  let baseUrl: string;

  if (process.env.VERCEL_ENV === "production") {
    baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  } else if (process.env.VERCEL_ENV === "preview") {
    baseUrl = `https://${process.env.VERCEL_BRANCH_URL}`;
  } else {
    const port = process.env.PORT || "3000";
    baseUrl = `http://localhost:${port}`;
  }

  return `${baseUrl}/_next/static/sandbox/bundle-${hash}.js`;
}

/**
 * Ensure the runner script is installed in the sandbox.
 */
async function ensureRunnerInstalled(sandbox: Sandbox): Promise<void> {
  if (sandboxesWithRunner.has(sandbox)) {
    return;
  }

  await sandbox.writeFiles([
    { path: RUNNER_SCRIPT_PATH, content: Buffer.from(RUNNER_SCRIPT, "utf-8") },
  ]);

  sandboxesWithRunner.add(sandbox);
}

/**
 * Internal function called by transformed "use sandbox" functions.
 * Orchestrates sandbox creation and function execution.
 */
export async function __runSandboxFn<T>(
  options: RunSandboxFnOptions
): Promise<T> {
  const { fnId, config, args } = options;

  // Create or get sandbox (for now, always create - getOrCreate comes later)
  const sandbox = await Sandbox.create({
    timeout: config.timeout ?? 300_000,
    // Note: vcpus and memory would be passed here when supported
  });

  try {
    // Ensure runner script is installed
    await ensureRunnerInstalled(sandbox);

    // Get bundle URL
    const bundleUrl = getBundleUrl();

    // Run the function via the runner script
    const argsJson = JSON.stringify(args);
    const result = await sandbox.runCommand("node", [
      RUNNER_SCRIPT_PATH,
      bundleUrl,
      fnId,
      argsJson,
    ]);

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
        // JSON parse failed - likely an error in the runner
        throw new Error(
          `Sandbox execution failed.\nstdout: ${stdout}\nstderr: ${stderr}`
        );
      }
      throw e;
    }
  } finally {
    await sandbox.stop();
  }
}

/**
 * sandboxConfig is a marker function used in "use sandbox" functions
 * to configure sandbox options. It's extracted at build time and
 * never actually executes at runtime.
 */
export function sandboxConfig(_config: SandboxConfig): void {
  // This function is extracted at build time.
  // If it runs, the transform didn't work correctly.
  throw new Error(
    "sandboxConfig() was called at runtime. This indicates the 'use sandbox' " +
      "transform is not working correctly. Make sure you're using withSandbox() " +
      "in your next.config.ts."
  );
}
