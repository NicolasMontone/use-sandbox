import { Sandbox } from '@vercel/sandbox';
import { sandboxContext, hasSandboxContext } from './context.js';

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
      'Make sure your exec function is called from within a function marked with "use sandbox".'
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
    { path: tempFile, content: Buffer.from(wrappedCode, 'utf-8') }
  ]);

  const result = await sandbox.runCommand('node', [tempFile]);
  const stdout = await result.stdout();
  
  // Parse the result
  try {
    const lines = stdout.trim().split('\n');
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
    throw new Error(
      'readFile must be called within a "use sandbox" context.'
    );
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
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Write a file to the sandbox filesystem.
 * Must be called within a "use sandbox" context.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  const sandbox = sandboxContext.getStore();
  if (!sandbox) {
    throw new Error(
      'writeFile must be called within a "use sandbox" context.'
    );
  }

  await sandbox.writeFiles([
    { path, content: Buffer.from(content, 'utf-8') }
  ]);
}
