# @use-sandbox/core

Runtime for `"use sandbox"` and `"use exec"` directives with Vercel Sandbox.

## Overview

This package provides the runtime support for the sandbox directive system, enabling secure execution of code in isolated Vercel Sandbox environments.

## Directives

### `"use sandbox"`

Establishes a sandbox session context. All `"use exec"` calls within this context share the same sandbox instance.

```typescript
async function agent() {
  'use sandbox';
  
  // All exec calls here use the same sandbox
  const content = await readFile('/tmp/test.txt');
  await writeFile('/tmp/output.txt', processedContent);
  
  return content;
}
```

### `"use exec"`

Marks code that should execute inside the sandbox.

```typescript
async function readFile(path: string) {
  'use exec';
  const fs = await import('fs/promises');
  return fs.readFile(path, 'utf-8');
}
```

## Usage with AI SDK

```typescript
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

## License

Apache-2.0

