/**
 * Example: Combining "use workflow" with "use sandbox"
 *
 * Pattern: workflow function -> step function -> sandbox.run()
 *
 * The sandbox functions are in a separate file (lib/sandbox-functions.ts)
 * to avoid conflicts between the workflow and sandbox transformers.
 */

import { sandbox } from "../lib/sbx";
import {
  sandboxWriteFile,
  sandboxReadFile,
  sandboxListFiles,
} from "../lib/sandbox-functions";

// ============================================================================
// Step functions - these call sandbox.run()
// ============================================================================

export async function writeFileStep(opts: {
  sandboxKey: string;
  path: string;
  content: string;
}): Promise<string> {
  "use step";
  const { sandboxKey, path, content } = opts;
  return sandbox.run(sandboxKey, sandboxWriteFile, [path, content]);
}

export async function readFileStep(opts: {
  sandboxKey: string;
  path: string;
}): Promise<string> {
  "use step";
  const { sandboxKey, path } = opts;

  try {
    return await sandbox.run(sandboxKey, sandboxReadFile, [path]);
  } catch (error) {
    return `Error reading file: ${String((error as Error)?.message)}`;
  }
}

export async function listFilesStep(opts: {
  sandboxKey: string;
  directory: string;
}): Promise<string[]> {
  "use step";
  const { sandboxKey, directory } = opts;
  return sandbox.run(sandboxKey, sandboxListFiles, [directory]);
}

// ============================================================================
// Workflow function
// ============================================================================

export async function sandboxFileWorkflow(sandboxKey: string) {
  "use workflow";

  // Step 1: Write a file in the sandbox
  const writeResult = await writeFileStep({
    sandboxKey,
    path: "/tmp/workflow-test/hello.txt",
    content: `Hello from the workflow! Timestamp: ${new Date().toISOString()}`,
  });
  console.log("[workflow] Write result:", writeResult);

  // Step 2: Read the file back (same sandbox, so file persists)
  const content = await readFileStep({
    sandboxKey,
    path: "/tmp/workflow-test/hello.txt",
  });
  console.log("[workflow] Read content:", content);

  // Step 3: List the directory
  const files = await listFilesStep({
    sandboxKey,
    directory: "/tmp/workflow-test",
  });
  console.log("[workflow] Files:", files);

  return {
    writeResult,
    content,
    files,
  };
}
