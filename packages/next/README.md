# @use-sandbox/next

Next.js integration for `"use sandbox"` and `"use exec"` directives.

## Installation

```bash
npm install @use-sandbox/next @use-sandbox/core
```

## Setup

Wrap your Next.js config with `withSandbox`:

```typescript
// next.config.ts
import { withSandbox } from '@use-sandbox/next';

export default withSandbox({
  // your existing next config
});
```

## Usage

### `"use sandbox"` Directive

Establishes a sandbox session context. All `"use exec"` calls within this context share the same sandbox instance.

```typescript
export async function POST(req: Request) {
  'use sandbox';
  
  // All exec calls here use the same sandbox
  const content = await readFile('/tmp/test.txt');
  return new Response(content);
}
```

### `"use exec"` Directive

Marks code that should execute inside the sandbox.

```typescript
async function readFile(path: string) {
  'use exec';
  const fs = await import('fs/promises');
  return fs.readFile(path, 'utf-8');
}
```

## Example with AI SDK

```typescript
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

async function readFile(path: string) {
  'use exec';
  const fs = await import('fs/promises');
  return fs.readFile(path, 'utf-8');
}

async function writeFile(path: string, content: string) {
  'use exec';
  const fs = await import('fs/promises');
  await fs.writeFile(path, content);
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
      writeFile: {
        parameters: { path: { type: 'string' }, content: { type: 'string' } },
        execute: async ({ path, content }) => writeFile(path, content),
      },
    },
  });
}
```

## License

Apache-2.0

