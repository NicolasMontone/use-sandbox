# Use Workflow + Use Sandbox Example

This example demonstrates combining **"use workflow"** (durable workflows) with **"use sandbox"** (isolated execution).

## Pattern

```
workflow function    →    step function    →    sandbox.run()
"use workflow"            "use step"            "use sandbox"
```

- **Workflow functions** orchestrate durable execution with replay semantics
- **Step functions** perform side effects with full Node.js access
- **Sandbox functions** run code in isolated Vercel Sandbox environments

## Example Structure

```typescript
// Sandbox function - runs in isolated environment
async function sandboxWriteFile(path: string, content: string) {
  "use sandbox";
  const fs = await import("fs/promises");
  await fs.writeFile(path, content);
  return `Wrote to ${path}`;
}

// Step function - has side effects, calls sandbox
async function writeFileStep({ sandboxKey, path, content }) {
  "use step";
  return sandbox.run(sandboxKey, sandboxWriteFile, [path, content]);
}

// Workflow function - durable orchestration
async function myWorkflow(sandboxKey: string) {
  "use workflow";
  
  // Multiple sandbox operations share the same sandbox via sandboxKey
  await writeFileStep({ sandboxKey, path: "/tmp/file.txt", content: "hello" });
  const content = await readFileStep({ sandboxKey, path: "/tmp/file.txt" });
  
  return content;
}
```

## Key Insight

The `sandboxKey` allows multiple step executions to share the same sandbox instance, enabling workflows that:

1. Write files in one step
2. Read/modify them in subsequent steps
3. All within the same isolated environment

## Running

```bash
pnpm dev
```

Then visit http://localhost:3000 or call:

```bash
curl http://localhost:3000/api/trigger?key=my-session
```

## Current Status

This example currently demonstrates the pattern without the full workflow integration (which requires additional package setup). The `"use sandbox"` directive is fully functional - sandbox functions are transformed and run in isolated Vercel Sandboxes.

Once the workflow package dependencies are resolved, the `"use workflow"` and `"use step"` directives would add durability and replay semantics to the execution.
