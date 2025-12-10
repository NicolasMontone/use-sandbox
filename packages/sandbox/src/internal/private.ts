/**
 * Internal registration functions for sandbox exec functions.
 * Similar to workflow's registerStepFunction pattern.
 */

export type ExecFunction<
  Args extends unknown[] = unknown[],
  Result = unknown,
> = ((...args: Args) => Promise<Result>);

const registeredExecFunctions = new Map<string, ExecFunction>();

/**
 * Register an exec function to be transformed and executed in sandbox.
 * This is called by the transformed code at module initialization.
 */
export function registerExecFunction(execId: string, execFn: ExecFunction): void {
  registeredExecFunctions.set(execId, execFn);
}

/**
 * Get a registered exec function by ID.
 */
export function getExecFunction(execId: string): ExecFunction | undefined {
  return registeredExecFunctions.get(execId);
}

/**
 * Get all registered exec function IDs.
 */
export function getRegisteredExecIds(): string[] {
  return Array.from(registeredExecFunctions.keys());
}

