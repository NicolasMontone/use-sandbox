import { streamText, stepCountIs, type CoreMessage } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";

/**
 * Read a file from the sandbox filesystem.
 * This function runs inside the sandbox.
 */
async function sandboxReadFile(path: string): Promise<string> {
  "use sandbox";
  const fs = await import("fs/promises");
  try {
    return await fs.readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `Error: File not found at ${path}`;
    }
    throw error;
  }
}

/**
 * Write content to a file in the sandbox filesystem.
 * This function runs inside the sandbox.
 */
async function sandboxWriteFile(
  path: string,
  content: string
): Promise<string> {
  "use sandbox";
  const fs = await import("fs/promises");
  const pathModule = await import("path");

  // Ensure directory exists
  const dir = pathModule.dirname(path);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(path, content, "utf-8");
  return `Successfully wrote ${content.length} bytes to ${path}`;
}

/**
 * List files in a directory in the sandbox filesystem.
 * This function runs inside the sandbox.
 */
async function sandboxListFiles(directory: string): Promise<string> {
  "use sandbox";
  const fs = await import("fs/promises");
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries.map(
      (entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`
    );
    return files.length > 0 ? files.join("\n") : "Directory is empty";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `Error: Directory not found at ${directory}`;
    }
    throw error;
  }
}

/**
 * Run a shell command in the sandbox.
 * This function runs inside the sandbox.
 */
async function sandboxRunCommand(command: string): Promise<string> {
  "use sandbox";
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    const { stdout, stderr } = await execAsync(command);
    return stdout || stderr || "Command completed with no output";
  } catch (error) {
    return `Error executing command: ${(error as Error).message}`;
  }
}

/**
 * Main chat handler. Uses sandboxConfig to configure a per-session sandbox.
 */
export async function POST(req: Request) {
  const {
    messages,
    sessionId,
  }: { messages: CoreMessage[]; sessionId?: string } = await req.json();

  const result = streamText({
    model: gateway("openai/gpt-4o"),
    system: `You are a helpful AI assistant with access to a sandboxed file system.
You can read, write, and list files, as well as run shell commands.
The sandbox runs on a Linux system with Node.js installed.
The working directory is /home/user and you have full access to /tmp.
Always confirm with the user before making changes.`,
    tools: {
      readFile: {
        description: "Read the contents of a file from the sandbox filesystem",
        inputSchema: z.object({
          path: z.string().describe("The absolute path to the file to read"),
        }),
        execute: async ({ path }) => {
          return await sandboxReadFile(path);
        },
      },
      writeFile: {
        description: "Write content to a file in the sandbox filesystem",
        inputSchema: z.object({
          path: z.string().describe("The absolute path to the file to write"),
          content: z.string().describe("The content to write to the file"),
        }),
        execute: async ({ path, content }) => {
          console.log("Writing file", path, content);
          return await sandboxWriteFile(path, content);
        },
      },
      listFiles: {
        description: "List files and directories in the sandbox filesystem",
        inputSchema: z.object({
          directory: z
            .string()
            .describe("The absolute path to the directory to list"),
        }),
        execute: async ({ directory }) => {
          console.log("Listing files in", directory);
          return await sandboxListFiles(directory);
        },
      },
      runCommand: {
        description: "Run a shell command in the sandbox (use with caution)",
        inputSchema: z.object({
          command: z.string().describe("The shell command to execute"),
        }),
        execute: async ({ command }) => {
          console.log("Running command", command);
          return await sandboxRunCommand(command);
        },
      },
    },
    stopWhen: stepCountIs(10),
    messages,
  });

  return result.toTextStreamResponse();
}
