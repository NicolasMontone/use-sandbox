# AI Agent with Sandbox Example

This example demonstrates the `"use sandbox"` and `"use exec"` directives with AI SDK integration.

## Overview

The app provides an AI chat interface where the AI agent has access to a sandboxed file system. The agent can:

- **Read files** from the sandbox
- **Write files** to the sandbox
- **List directory contents**
- **Run shell commands**

All operations run securely inside a Vercel Sandbox instance.

## How It Works

### `"use sandbox"` Directive

The main API route uses `"use sandbox"` to establish a sandbox session:

```typescript
export async function POST(req: Request) {
  'use sandbox';
  
  // All tool executions share the same sandbox instance
  return streamText({
    tools: { ... }
  });
}
```

### `"use exec"` Directive

Individual file operations use `"use exec"` to run inside the sandbox:

```typescript
async function sandboxReadFile(path: string) {
  'use exec';
  const fs = await import('fs/promises');
  return fs.readFile(path, 'utf-8');
}
```

## Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Set up your OpenAI API key:
   ```bash
   export OPENAI_API_KEY=your-key-here
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

## License

Apache-2.0

