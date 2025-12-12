/**
 * Safe shell command execution using template literals.
 *
 * Uses `execFile` instead of `exec` to avoid shell injection vulnerabilities.
 * Interpolated values are treated as single arguments, not shell-interpreted.
 *
 * @example
 * ```typescript
 * async function gitOps(message: string) {
 *   "use sandbox";
 *
 *   await $`git add .`;
 *   const result = await $`git commit -m ${message}`;
 *   return result;
 * }
 * ```
 *
 * Security: Even if `message` contains `; rm -rf /`, it's treated as a literal
 * argument to `-m`, not executed as a separate command.
 */
export async function $(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<string> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  // Parse template into [cmd, ...args]
  const args: string[] = [];

  for (let i = 0; i < strings.length; i++) {
    // Split static parts by whitespace into separate args
    const staticParts = strings[i].trim().split(/\s+/).filter(Boolean);
    args.push(...staticParts);

    // Interpolated values become single arguments (safe - no shell parsing)
    if (i < values.length) {
      args.push(String(values[i]));
    }
  }

  const [cmd, ...rest] = args;

  if (!cmd) {
    throw new Error("Empty command");
  }

  try {
    const { stdout, stderr } = await execFileAsync(cmd, rest);
    return stdout || stderr || "";
  } catch (error) {
    const err = error as Error & { stderr?: string };
    // Include stderr in error message for better debugging
    const message = err.stderr || err.message;
    throw new Error(`Command failed: ${cmd} ${rest.join(" ")}\n${message}`);
  }
}

