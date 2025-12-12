/**
 * Sandbox functions - these run in isolated Vercel Sandboxes.
 *
 * Kept in a separate file from workflow/step functions to avoid
 * conflicts between the two transformer systems.
 */

/**
 * Write content to a file in the sandbox filesystem.
 */
export async function sandboxWriteFile(
  path: string,
  content: string
): Promise<string> {
  "use sandbox";
  const fs = await import("fs/promises");
  const pathModule = await import("path");

  const dir = pathModule.dirname(path);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(path, content, "utf-8");
  return `Wrote ${content.length} bytes to ${path}`;
}

/**
 * Read a file from the sandbox filesystem.
 */
export async function sandboxReadFile(path: string): Promise<string> {
  "use sandbox";
  const fs = await import("fs/promises");

  try {
    return await fs.readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`File not found: ${path}`);
    }
    throw error;
  }
}

/**
 * List files in a directory.
 */
export async function sandboxListFiles(directory: string): Promise<string[]> {
  "use sandbox";
  const fs = await import("fs/promises");

  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.map(
    (entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`
  );
}
