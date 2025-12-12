# AI Agent with Sandbox Example

This example demonstrates how to use `@use-sandbox/core` with AI SDK to build an AI agent with sandboxed file system access.

## Overview

The app provides an AI chat interface where the AI agent has access to a sandboxed file system. The agent can:

- **Read files** from the sandbox
- **Write files** to the sandbox
- **List directory contents**
- **Run shell commands**
- **Generate text** using AI inside the sandbox

All operations run securely inside a sandbox instance with session-based pooling.

## How It Works

### `defineSandbox` Configuration

Create a sandbox configuration with resource limits:

```typescript
import { defineSandbox } from "@use-sandbox/core";

const sandbox = defineSandbox({
  resources: { vcpus: 2 },
  timeout: 300_000,
});
```

### `"use sandbox"` Directive

Individual functions use the `"use sandbox"` directive to mark them for sandbox execution:

```typescript
async function sandboxReadFile(path: string): Promise<string> {
  "use sandbox";
  const fs = await import("fs/promises");
  return fs.readFile(path, "utf-8");
}
```

### `sandbox.run()` with Session Pooling

Execute sandbox functions with session-based pooling for efficient reuse:

```typescript
// Same sessionId = same sandbox instance
const result = await sandbox.run(sessionId, sandboxReadFile, [path]);
```

### Safe Shell Commands with `$` Template Literal

For developer-controlled commands, use the `$` template literal which safely handles interpolation:

```typescript
async function sandboxGitCommit(message: string): Promise<string> {
  "use sandbox";
  await $`git add .`;
  const result = await $`git commit -m ${message}`; // Safe: message is a single argument
  return result;
}
```

## Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Set up your AI Gateway API key:
   ```bash
   export AI_GATEWAY_API_KEY=your-key-here
   ```

3. Run the development server:
   ```bash
   pnpm dev
   ```

4. Open [http://localhost:3000](http://localhost:3000)

## Example Prompts

Try asking the AI:

- "Create a file called hello.txt in /tmp with 'Hello World' content"
- "Read the contents of /tmp/hello.txt"
- "List all files in /tmp"
- "Run `uname -a` to show system info"
- "Generate a poem about coding"

## License

Apache-2.0
