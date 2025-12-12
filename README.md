# use-sandbox

Run code in [Vercel Sandbox](https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot-tool-usage) using a simple directive. Mark any function with `"use sandbox"` and it executes in an isolated environment.

## Installation

```bash
pnpm install @use-sandbox/core @use-sandbox/next
```

## Setup

Wrap your Next.js config:

```typescript
// next.config.ts
import { withSandbox } from "@use-sandbox/next";

export default withSandbox({
  // your existing config
});
```

## Usage

### 1. Define your sandbox

Create a sandbox definition with your desired configuration:

```typescript
import { defineSandbox } from "@use-sandbox/core";

const sandbox = defineSandbox({
  resources: { vcpus: 2 },
  timeout: 300_000,
});
```

### 2. Write sandbox functions

Add the `"use sandbox"` directive to any function that should run inside the sandbox:

```typescript
import fs from "fs/promises";

async function readFile(path: string): Promise<string> {
  "use sandbox";
  return fs.readFile(path, "utf-8");
}

async function writeFile(path: string, content: string): Promise<void> {
  "use sandbox";
  await fs.writeFile(path, content, "utf-8");
}

async function runCommand(cmd: string): Promise<string> {
  "use sandbox";
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);
  const { stdout } = await execAsync(cmd);
  return stdout;
}
```

### 3. Run them

Use `sandbox.run()` to execute your functions. Pass a session key for sandbox pooling—same key reuses the same sandbox instance:

```typescript
export async function POST(req: Request) {
  const { sessionId } = await req.json();

  // Same sessionId = same sandbox (pooled)
  const content = await sandbox.run(sessionId, readFile, ["/tmp/data.txt"]);

  return Response.json({ content });
}
```

## API Reference

### `defineSandbox(config)`

Creates a sandbox definition for running sandbox functions.

```typescript
const sandbox = defineSandbox({
  resources: { vcpus: 2, memory: 512 },
  timeout: 300_000,
  // ...other Vercel Sandbox options
});
```

### `sandbox.run(keyOrOptions, fn, args)`

Execute a sandbox function.

```typescript
// Simple: just a session key
await sandbox.run(sessionId, myFunction, [arg1, arg2]);

// With options
await sandbox.run({ key: sessionId, sudo: false }, myFunction, [arg1, arg2]);
```

**Parameters:**

- `keyOrOptions`: A string key for sandbox pooling, or an options object `{ key, sudo? }`
- `fn`: The sandbox function to run (must have `"use sandbox"` directive)
- `args`: Arguments to pass to the function (as an array)

### `sandbox.stop(key)` / `sandbox.stopAll()`

Clean up sandbox instances:

```typescript
await sandbox.stop(sessionId); // Stop a specific sandbox
await sandbox.stopAll(); // Stop all sandboxes in the pool
```

### `$` (shell template literal)

Safe shell command execution inside sandbox functions. Interpolated values are treated as single arguments, preventing shell injection:

```typescript
import { $ } from "@use-sandbox/core";

async function gitCommit(message: string): Promise<string> {
  "use sandbox";
  await $`git add .`;
  return $`git commit -m ${message}`;
}
```

Even if `message` contains `; rm -rf /`, it's passed as a literal argument to `-m`, not executed.

## Example: AI Agent with File Tools

```typescript
import { streamText } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";
import fs from "fs/promises";
import { defineSandbox } from "@use-sandbox/core";

const sandbox = defineSandbox({ resources: { vcpus: 2 } });

async function sandboxReadFile(path: string) {
  "use sandbox";
  return fs.readFile(path, "utf-8");
}

async function sandboxWriteFile(path: string, content: string) {
  "use sandbox";
  await fs.writeFile(path, content, "utf-8");
  return `Wrote ${content.length} bytes to ${path}`;
}

export async function POST(req: Request) {
  const { messages, sessionId } = await req.json();

  return streamText({
    model: gateway("anthropic/claude-sonnet-4.5"),
    messages,
    tools: {
      readFile: {
        description: "Read a file",
        inputSchema: z.object({ path: z.string() }),
        execute: ({ path }) => sandbox.run(sessionId, sandboxReadFile, [path]),
      },
      writeFile: {
        description: "Write a file",
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: ({ path, content }) =>
          sandbox.run(sessionId, sandboxWriteFile, [path, content]),
      },
    },
  });
}
```

## How It Works

The `@use-sandbox/next` loader transforms your code at build time. Functions with the `"use sandbox"` directive are extracted and bundled separately.

**Your code:**

```typescript
async function readFile(path: string) {
  "use sandbox";
  const fs = await import("fs/promises");
  return fs.readFile(path, "utf-8");
}
```

**Transformed:**

```typescript
import { __runSandboxFn } from "@use-sandbox/core/runtime";

async function readFile(path: string) {
  return __runSandboxFn({ fnId: "readFile_abc123", args: [path] });
}
```

The function body is bundled and executed inside the sandbox VM when called.

## Development

```bash
pnpm install      # Install dependencies
pnpm build        # Build all packages
pnpm dev          # Watch mode

# Run the example
cd examples/ai-agent
pnpm dev
```

## FAQ

### Why a `"use sandbox"` directive?

To clearly mark a compiler boundary. Just like `"use server"` tells the Next.js compiler "this function runs on the server," `"use sandbox"` tells our compiler "this function runs in an isolated sandbox." The directive makes the execution context explicit and enables build-time transformation.

---

## License

Apache-2.0
