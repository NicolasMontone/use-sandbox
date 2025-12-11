/**
 * Build-time registry for collecting sandbox function metadata.
 *
 * During the build, as the loader processes files, it registers
 * sandbox function info here. The bundler then creates re-exports
 * from the original source files, letting esbuild handle dependency resolution.
 */

export interface RegisteredFunction {
  fnId: string;
  fnName: string;
  sourceFile: string;
}

const registry = new Map<string, RegisteredFunction>();

export function registerSandboxFunction(
  fnId: string,
  fnName: string,
  sourceFile: string
): void {
  registry.set(fnId, { fnId, fnName, sourceFile });
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
