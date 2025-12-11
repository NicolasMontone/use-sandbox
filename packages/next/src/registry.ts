/**
 * Build-time registry for collecting extracted sandbox functions.
 *
 * During the build, as the loader processes files, it registers
 * extracted sandbox function bodies here. After all files are processed,
 * the bundler reads from this registry to create the final bundle.
 */

export interface RegisteredFunction {
  fnId: string;
  body: string;
  sourceFile: string;
}

const registry = new Map<string, RegisteredFunction>();

export function registerSandboxFunction(
  fnId: string,
  body: string,
  sourceFile: string
): void {
  registry.set(fnId, { fnId, body, sourceFile });
}

export function getRegisteredFunctions(): RegisteredFunction[] {
  return Array.from(registry.values());
}

export function clearRegistry(): void {
  registry.clear();
}

export function hasRegisteredFunctions(): boolean {
  return registry.size > 0;
}

export function getRegistrySize(): number {
  return registry.size;
}

