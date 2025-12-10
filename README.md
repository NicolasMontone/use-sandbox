# use-sandbox

A directive-based approach to securely execute code in Vercel Sandbox, inspired by React's `"use server"` pattern.

## Packages

- **[@use-sandbox/core](./packages/sandbox)** - Runtime for `"use sandbox"` and `"use exec"` directives
- **[@use-sandbox/next](./packages/next)** - Next.js integration with loader and config wrapper

## Directives

### `"use sandbox"`

Establishes a sandbox session context. Similar to `"use workflow"` in Workflow DevKit.

```typescript
export async function POST(req: Request) {
  'use sandbox';
  
  // All exec calls share the same sandbox instance
  const content = await readFile('/tmp/test.txt');
  return new Response(content);
}
```

### `"use exec"`

Marks code that executes inside the sandbox. Similar to `"use step"` in Workflow DevKit.

```typescript
async function readFile(path: string) {
  'use exec';
  const fs = await import('fs/promises');
  return fs.readFile(path, 'utf-8');
}
```

## Quick Start

1. Install packages:

```bash
npm install @use-sandbox/core @use-sandbox/next
```

2. Configure Next.js:

```typescript
// next.config.ts
import { withSandbox } from '@use-sandbox/next';

export default withSandbox({
  // your config
});
```

3. Use the directives:

```typescript
// app/api/agent/route.ts
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

async function readFile(path: string) {
  'use exec';
  const fs = await import('fs/promises');
  return fs.readFile(path, 'utf-8');
}

export async function POST(req: Request) {
  'use sandbox';
  
  const { messages } = await req.json();
  
  return streamText({
    model: openai('gpt-4o'),
    messages,
    tools: {
      readFile: {
        parameters: { path: { type: 'string' } },
        execute: async ({ path }) => readFile(path),
      },
    },
  });
}
```

## Examples

- **[AI Agent](./examples/ai-agent)** - Chat interface with file system tools

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run example
cd examples/ai-agent
pnpm dev
```

## How It Works

The JS loader transforms your code at build time:

**Input:**
```typescript
async function readFile(path: string) {
  'use exec';
  const fs = await import('fs/promises');
  return fs.readFile(path, 'utf-8');
}

export async function POST(req: Request) {
  'use sandbox';
  return await readFile('/tmp/test.txt');
}
```

**Output:**
```typescript
import { runInSandbox, execInSandbox } from '@use-sandbox/core/runtime';

async function readFile(path: string) {
  return execInSandbox(`
    const { path } = __args;
    const fs = await import('fs/promises');
    return fs.readFile(path, 'utf-8');
  `, { path });
}

export async function POST(req: Request) {
  return runInSandbox(async () => {
    return await readFile('/tmp/test.txt');
  });
}
```

## License

Apache-2.0

