import {
  streamText,
  stepCountIs,
  UIMessage,
  convertToModelMessages,
  generateText,
} from "ai";
import { gateway, createGateway } from "@ai-sdk/gateway";
import { z } from "zod";
import fs from "fs/promises";
import { defineSandbox, $ } from "@use-sandbox/core";

// Helper to log with timestamp
function log(context: string, message: string, data?: unknown) {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, -1);
  console.log(`[${timestamp}] [${context}] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Define the sandbox configuration once
const sandbox = defineSandbox({ resources: { vcpus: 2 }, timeout: 300_000 });

/**
 * Read a file from the sandbox filesystem.
 * This function runs inside the sandbox.
 */
async function sandboxReadFile(path: string): Promise<string> {
  "use sandbox";
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
 * Read a file from the sandbox filesystem.
 * This function runs inside the sandbox.
 */
async function generateTextWithAI({
  message,
  apiKey,
}: {
  message: string;
  apiKey: string;
}) {
  "use sandbox";
  try {
    const gateway = createGateway({ apiKey });
    const result = await generateText({
      system: "You are a helpful assistant that can generate text.",
      model: gateway("deepseek/deepseek-v3.1"),
      messages: [{ role: "user", content: message }],
    });
    return result.content;
  } catch (error) {
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
 *
 * Note: For AI-provided commands, we use exec() since the command string
 * comes at runtime. This is acceptable because the sandbox isolates execution.
 *
 * For developer-controlled commands, prefer the $ template literal:
 *   await $`git status`
 *   await $`git commit -m ${message}`  // Safe: message is a single argument
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
 * Example: Safe git operations using the $ template literal.
 * Interpolated values are treated as single arguments, preventing injection.
 */
async function sandboxGitCommit(message: string): Promise<string> {
  "use sandbox";
  try {
    await $`git add .`;
    const result = await $`git commit -m ${message}`;
    return result;
  } catch (error) {
    return `Git error: ${(error as Error).message}`;
  }
}

/**
 * Main chat handler.
 * Uses sandbox.run() with sessionId for sandbox pooling.
 */
export async function POST(req: Request) {
  const {
    messages,
    sessionId = "default",
  }: { messages: UIMessage[]; sessionId?: string } = await req.json();

  log("POST", `Received ${messages.length} messages`, { sessionId });

  const result = streamText({
    model: gateway("anthropic/claude-sonnet-4.5"),
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
          log("TOOL", "readFile called", { path, sessionId });
          const startTime = Date.now();
          try {
            // Use sandbox.run with sessionId for pooling (args as array)
            const result = await sandbox.run(sessionId, sandboxReadFile, [
              path,
            ]);

            log("TOOL", `readFile completed in ${Date.now() - startTime}ms`, {
              path,
              resultLength: result.length,
              preview: result.slice(0, 100),
            });
            return result;
          } catch (error) {
            log("TOOL", "readFile ERROR", { path, error: String(error) });
            throw error;
          }
        },
      },
      generateText: {
        description: "Generate text with AI",
        inputSchema: z.object({
          message: z.string().describe("The message to generate text with"),
        }),
        execute: async ({ message }) => {
          log("TOOL", "generateText called", { message, sessionId });
          const startTime = Date.now();
          try {
            // Use sandbox.run with sessionId for pooling (args as array)
            const result = await sandbox.run(sessionId, generateTextWithAI, [
              { message, apiKey: process.env.AI_GATEWAY_API_KEY! },
            ]);

            log(
              "TOOL",
              `generateText completed in ${Date.now() - startTime}ms`,
              result
            );
            return result;
          } catch (error) {
            log("TOOL", "generateText ERROR", {
              message,
              error: String(error),
            });
            throw error;
          }
        },
      },
      writeFile: {
        description: "Write content to a file in the sandbox filesystem",
        inputSchema: z.object({
          path: z.string().describe("The absolute path to the file to write"),
          content: z.string().describe("The content to write to the file"),
        }),
        execute: async ({ path, content }) => {
          log("TOOL", "writeFile called", {
            path,
            contentLength: content.length,
            sessionId,
          });
          const startTime = Date.now();
          try {
            const result = await sandbox.run(sessionId, sandboxWriteFile, [
              path,
              content,
            ]);
            log("TOOL", `writeFile completed in ${Date.now() - startTime}ms`, {
              path,
              result,
            });
            return result;
          } catch (error) {
            log("TOOL", "writeFile ERROR", { path, error: String(error) });
            throw error;
          }
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
          log("TOOL", "listFiles called", { directory, sessionId });
          const startTime = Date.now();
          try {
            const result = await sandbox.run(sessionId, sandboxListFiles, [
              directory,
            ]);
            log("TOOL", `listFiles completed in ${Date.now() - startTime}ms`, {
              directory,
              result,
            });
            return result;
          } catch (error) {
            log("TOOL", "listFiles ERROR", { directory, error: String(error) });
            throw error;
          }
        },
      },
      runCommand: {
        description: "Run a shell command in the sandbox (use with caution)",
        inputSchema: z.object({
          command: z.string().describe("The shell command to execute"),
        }),
        execute: async ({ command }) => {
          log("TOOL", "runCommand called", { command, sessionId });
          const startTime = Date.now();
          try {
            const result = await sandbox.run(sessionId, sandboxRunCommand, [
              command,
            ]);
            log("TOOL", `runCommand completed in ${Date.now() - startTime}ms`, {
              command,
              result,
            });
            return result;
          } catch (error) {
            log("TOOL", "runCommand ERROR", { command, error: String(error) });
            throw error;
          }
        },
      },
    },
    stopWhen: stepCountIs(10),
    messages: convertToModelMessages(messages),
  });

  log("POST", "Streaming response...");
  return result.toUIMessageStreamResponse();
}
