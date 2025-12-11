/**
 * Transformer V2: Clean implementation inspired by Workflow.
 *
 * Key differences from V1:
 * 1. Handles nested sandbox functions (not just top-level)
 * 2. Detects closure variables for nested functions
 * 3. Generates .sandbox.ts files for clean bundling
 * 4. Hoists nested functions with parent$child naming
 */

import { parse } from "@swc/core";
import type {
  Module,
  ModuleItem,
  Statement,
  Expression,
  BlockStatement,
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunctionExpression,
  Identifier,
  Pattern,
  Param,
  VariableDeclaration,
} from "@swc/core";
import { createHash } from "crypto";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, basename } from "path";

// ============================================================================
// Types
// ============================================================================

export interface TransformResult {
  code: string;
  hasSandboxFunctions: boolean;
  sandboxFilePath: string | null;
  sandboxFileContent: string | null;
}

interface SandboxFunction {
  /** Unique identifier: parentName$fnName_hash */
  fnId: string;
  /** Original name in source */
  originalName: string;
  /** Full scope path: ["POST", "nested", "deep"] */
  scopePath: string[];
  /** Parameter names */
  params: string[];
  /** Captured closure variables (for nested functions) */
  closureVars: string[];
  /** Source code of the function body (after "use sandbox" directive) */
  bodySource: string;
  /** Full function source for the .sandbox.ts file */
  fullSource: string;
  /** Location in original source for replacement */
  location: { start: number; end: number };
  /** Is this an async function? */
  isAsync: boolean;
}

interface ScopeInfo {
  /** Variables declared in this scope */
  declared: Set<string>;
  /** Parent scope */
  parent: ScopeInfo | null;
}

// ============================================================================
// Helpers
// ============================================================================

function createByteToCharMap(source: string): number[] {
  const buffer = Buffer.from(source, "utf-8");
  const map: number[] = new Array(buffer.length + 2);
  map[0] = 0;

  let codeUnitIndex = 0;
  let byteIndex = 0;

  for (const codePoint of source) {
    const charByteLength = Buffer.byteLength(codePoint, "utf-8");
    const charCodeUnitLength = codePoint.length;

    for (let i = 0; i < charByteLength; i++) {
      map[byteIndex + 1] = codeUnitIndex;
      byteIndex++;
    }
    codeUnitIndex += charCodeUnitLength;
  }

  map[byteIndex + 1] = codeUnitIndex;
  return map;
}

function generateFnId(scopePath: string[], bodyHash: string): string {
  const pathPart = scopePath.join("$");
  return `${pathPart}_${bodyHash}`;
}

function hashString(str: string): string {
  return createHash("sha256").update(str).digest("hex").slice(0, 8);
}

function isUseSandboxDirective(stmt: Statement): boolean {
  if (stmt.type !== "ExpressionStatement") return false;
  const expr = stmt.expression;
  if (expr.type !== "StringLiteral") return false;
  return expr.value === "use sandbox";
}

function extractParamNames(params: (Param | Pattern)[]): string[] {
  const names: string[] = [];

  function fromPattern(p: Pattern): void {
    switch (p.type) {
      case "Identifier":
        names.push(p.value);
        break;
      case "ObjectPattern":
        for (const prop of p.properties) {
          if (prop.type === "KeyValuePatternProperty") {
            fromPattern(prop.value);
          } else if (prop.type === "AssignmentPatternProperty") {
            names.push(prop.key.value);
          } else if (prop.type === "RestElement") {
            fromPattern(prop.argument);
          }
        }
        break;
      case "ArrayPattern":
        for (const elem of p.elements) {
          if (elem) fromPattern(elem);
        }
        break;
      case "RestElement":
        fromPattern(p.argument);
        break;
      case "AssignmentPattern":
        fromPattern(p.left);
        break;
    }
  }

  for (const param of params) {
    if ("pat" in param) {
      fromPattern(param.pat);
    } else {
      fromPattern(param as Pattern);
    }
  }

  return names;
}

// ============================================================================
// AST Walking
// ============================================================================

type AnyFunction =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunctionExpression;

interface WalkContext {
  source: string;
  byteToChar: (pos: number) => number;
  currentScope: ScopeInfo;
  scopePath: string[];
  sandboxFunctions: SandboxFunction[];
}

/**
 * Walk the AST to find all sandbox functions, including nested ones.
 */
function walkModule(module: Module, ctx: WalkContext): void {
  for (const item of module.body) {
    walkModuleItem(item, ctx);
  }
}

function walkModuleItem(item: ModuleItem, ctx: WalkContext): void {
  switch (item.type) {
    case "FunctionDeclaration":
      walkFunctionDecl(item, ctx, false, false);
      break;
    case "ExportDeclaration":
      if (item.declaration.type === "FunctionDeclaration") {
        walkFunctionDecl(item.declaration, ctx, true, false);
      } else if (item.declaration.type === "VariableDeclaration") {
        walkVarDecl(item.declaration, ctx);
      }
      break;
    case "ExportDefaultDeclaration":
      if (item.decl.type === "FunctionExpression") {
        walkFunctionExpr(item.decl, ctx, "default", true, true);
      }
      break;
    case "VariableDeclaration":
      walkVarDecl(item, ctx);
      break;
    default:
      // Walk into statement bodies
      if ("body" in item && item.body) {
        walkStatement(item as Statement, ctx);
      }
  }
}

function walkVarDecl(decl: VariableDeclaration, ctx: WalkContext): void {
  for (const d of decl.declarations) {
    // Register the variable in current scope
    if (d.id.type === "Identifier") {
      ctx.currentScope.declared.add(d.id.value);
    }

    // Check if it's a function expression
    if (d.init) {
      if (
        d.init.type === "FunctionExpression" ||
        d.init.type === "ArrowFunctionExpression"
      ) {
        const name = d.id.type === "Identifier" ? d.id.value : "anonymous";
        walkFunctionExpr(d.init, ctx, name, false, false);
      } else {
        walkExpression(d.init, ctx);
      }
    }
  }
}

function walkFunctionDecl(
  fn: FunctionDeclaration,
  ctx: WalkContext,
  _isExport: boolean,
  _isDefaultExport: boolean
): void {
  const name = fn.identifier.value;
  ctx.currentScope.declared.add(name);

  if (!fn.body) return;

  // Check for "use sandbox" directive
  const hasSandbox =
    fn.body.stmts.length > 0 && isUseSandboxDirective(fn.body.stmts[0]);

  if (hasSandbox) {
    collectSandboxFunction(fn, fn.body, name, ctx);
  } else {
    // Walk into function body with new scope
    walkFunctionBody(fn.body, fn.params, name, ctx);
  }
}

function walkFunctionExpr(
  fn: FunctionExpression | ArrowFunctionExpression,
  ctx: WalkContext,
  name: string,
  _isExport: boolean,
  _isDefaultExport: boolean
): void {
  const body = fn.body?.type === "BlockStatement" ? fn.body : null;

  if (!body) {
    // Arrow with expression body - walk the expression
    if (
      fn.type === "ArrowFunctionExpression" &&
      fn.body?.type !== "BlockStatement"
    ) {
      walkExpression(fn.body as Expression, ctx);
    }
    return;
  }

  // Check for "use sandbox" directive
  const hasSandbox =
    body.stmts.length > 0 && isUseSandboxDirective(body.stmts[0]);

  if (hasSandbox) {
    collectSandboxFunction(fn, body, name, ctx);
  } else {
    // Walk into function body with new scope
    walkFunctionBody(body, fn.params, name, ctx);
  }
}

function walkFunctionBody(
  body: BlockStatement,
  params: (Param | Pattern)[],
  fnName: string,
  ctx: WalkContext
): void {
  // Create new scope
  const newScope: ScopeInfo = {
    declared: new Set(extractParamNames(params)),
    parent: ctx.currentScope,
  };

  const newCtx: WalkContext = {
    ...ctx,
    currentScope: newScope,
    scopePath: [...ctx.scopePath, fnName],
  };

  for (const stmt of body.stmts) {
    walkStatement(stmt, newCtx);
  }
}

function walkStatement(stmt: Statement, ctx: WalkContext): void {
  switch (stmt.type) {
    case "VariableDeclaration":
      walkVarDecl(stmt, ctx);
      break;
    case "FunctionDeclaration":
      walkFunctionDecl(stmt, ctx, false, false);
      break;
    case "BlockStatement":
      for (const s of stmt.stmts) {
        walkStatement(s, ctx);
      }
      break;
    case "IfStatement":
      walkExpression(stmt.test, ctx);
      walkStatement(stmt.consequent, ctx);
      if (stmt.alternate) walkStatement(stmt.alternate, ctx);
      break;
    case "ForStatement":
      if (stmt.init?.type === "VariableDeclaration") {
        walkVarDecl(stmt.init, ctx);
      }
      if (stmt.test) walkExpression(stmt.test, ctx);
      if (stmt.update) walkExpression(stmt.update, ctx);
      walkStatement(stmt.body, ctx);
      break;
    case "WhileStatement":
      walkExpression(stmt.test, ctx);
      walkStatement(stmt.body, ctx);
      break;
    case "ReturnStatement":
      if (stmt.argument) walkExpression(stmt.argument, ctx);
      break;
    case "ExpressionStatement":
      walkExpression(stmt.expression, ctx);
      break;
    case "TryStatement":
      walkStatement(stmt.block, ctx);
      if (stmt.handler) walkStatement(stmt.handler.body, ctx);
      if (stmt.finalizer) walkStatement(stmt.finalizer, ctx);
      break;
    // Add more as needed
  }
}

function walkExpression(expr: Expression, ctx: WalkContext): void {
  switch (expr.type) {
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      const name =
        expr.type === "FunctionExpression" && expr.identifier
          ? expr.identifier.value
          : "anonymous";
      walkFunctionExpr(expr, ctx, name, false, false);
      break;
    case "CallExpression":
      // Callee could be Super or Import, skip those
      if (expr.callee.type !== "Super" && expr.callee.type !== "Import") {
        walkExpression(expr.callee, ctx);
      }
      for (const arg of expr.arguments) {
        if (arg.expression) walkExpression(arg.expression, ctx);
      }
      break;
    case "MemberExpression":
      walkExpression(expr.object, ctx);
      break;
    case "ObjectExpression":
      for (const prop of expr.properties) {
        if (prop.type === "KeyValueProperty" && prop.value) {
          walkExpression(prop.value, ctx);
        }
      }
      break;
    case "ArrayExpression":
      for (const elem of expr.elements) {
        if (elem?.expression) walkExpression(elem.expression, ctx);
      }
      break;
    case "ConditionalExpression":
      walkExpression(expr.test, ctx);
      walkExpression(expr.consequent, ctx);
      walkExpression(expr.alternate, ctx);
      break;
    case "BinaryExpression":
      walkExpression(expr.left, ctx);
      walkExpression(expr.right, ctx);
      break;
    case "UnaryExpression":
      walkExpression(expr.argument, ctx);
      break;
    case "AwaitExpression":
      walkExpression(expr.argument, ctx);
      break;
    case "AssignmentExpression":
      walkExpression(expr.right, ctx);
      break;
    case "TemplateLiteral":
      for (const e of expr.expressions) {
        walkExpression(e, ctx);
      }
      break;
    // Identifier doesn't need walking
  }
}

// ============================================================================
// Sandbox Function Collection
// ============================================================================

/**
 * Extract the original parameter source text from a function.
 * This preserves destructuring patterns, type annotations, defaults, etc.
 */
function getParamsSource(
  params: (Param | Pattern)[],
  source: string,
  byteToChar: (pos: number) => number
): string {
  if (params.length === 0) return "";

  // Get span from a param - prefer Param.span which includes type annotation
  const getSpan = (p: Param | Pattern): { start: number; end: number } => {
    const pAny = p as unknown as Record<string, unknown>;

    // Param type has its own span that includes type annotation
    if ("pat" in pAny && "span" in pAny) {
      const span = pAny.span as { start: number; end: number };
      return span;
    }
    // Fallback to pattern span (for arrow function params which are just patterns)
    if ("pat" in pAny) {
      const pat = pAny.pat as { span: { start: number; end: number } };
      return pat.span;
    }
    // Pattern type directly
    return (pAny as { span: { start: number; end: number } }).span;
  };

  const firstSpan = getSpan(params[0]);
  const lastSpan = getSpan(params[params.length - 1]);

  return source.slice(byteToChar(firstSpan.start), byteToChar(lastSpan.end));
}

function collectSandboxFunction(
  fn: AnyFunction,
  body: BlockStatement,
  name: string,
  ctx: WalkContext
): void {
  const scopePath = [...ctx.scopePath, name];
  const isNested = ctx.scopePath.length > 0;

  // Extract function parameter names (for closure detection)
  const paramNames = extractParamNames(fn.params);

  // Extract original parameter source (preserves destructuring, types, etc.)
  const paramsSource = getParamsSource(fn.params, ctx.source, ctx.byteToChar);

  // If nested, detect closure variables
  let closureVars: string[] = [];
  if (isNested) {
    closureVars = detectClosureVars(body, paramNames, ctx.currentScope);
  }

  // Extract source positions
  const fnStart = ctx.byteToChar(fn.span.start);
  const fnEnd = ctx.byteToChar(fn.span.end);

  // Get the body source (after "use sandbox" directive)
  const bodyStmts = body.stmts.slice(1); // Skip directive
  let bodySource = "";
  if (bodyStmts.length > 0) {
    const firstStmt = bodyStmts[0];
    const lastStmt = bodyStmts[bodyStmts.length - 1];
    bodySource = ctx.source.slice(
      ctx.byteToChar(firstStmt.span.start),
      ctx.byteToChar(lastStmt.span.end)
    );
  }

  const fnId = generateFnId(scopePath, hashString(bodySource));

  // Build the full function source for .sandbox.ts
  // Use original params source to preserve destructuring patterns
  const closureParam = closureVars.length > 0 ? "__closure" : "";
  const allParams = closureParam
    ? closureParam + (paramsSource ? ", " + paramsSource : "")
    : paramsSource;

  let fullSource = `export async function ${fnId}(${allParams}) {\n`;
  if (closureVars.length > 0) {
    fullSource += `  const { ${closureVars.join(", ")} } = __closure;\n`;
  }
  fullSource += `  ${bodySource}\n}`;

  ctx.sandboxFunctions.push({
    fnId,
    originalName: name,
    scopePath,
    params: paramNames,
    closureVars,
    bodySource,
    fullSource,
    location: { start: fnStart, end: fnEnd },
    isAsync: "async" in fn ? fn.async : true,
  });
}

/**
 * Detect variables that are:
 * - Referenced in the function body
 * - Not declared in the function (not params, not local vars)
 * - Declared in a parent scope
 */
function detectClosureVars(
  body: BlockStatement,
  params: string[],
  parentScope: ScopeInfo
): string[] {
  const referenced = new Set<string>();
  const locallyDeclared = new Set<string>(params);

  // Simple recursive collector for identifiers
  function collectRefs(node: unknown): void {
    if (!node || typeof node !== "object") return;

    const n = node as Record<string, unknown>;

    // Variable declaration
    if (n.type === "VariableDeclaration") {
      const decl = n as unknown as VariableDeclaration;
      for (const d of decl.declarations) {
        if (d.id.type === "Identifier") {
          locallyDeclared.add(d.id.value);
        }
        if (d.init) collectRefs(d.init);
      }
      return;
    }

    // Identifier reference
    if (n.type === "Identifier") {
      const id = n as unknown as Identifier;
      referenced.add(id.value);
      return;
    }

    // Recurse into children
    for (const key of Object.keys(n)) {
      if (key === "span" || key === "type") continue;
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) collectRefs(item);
      } else if (val && typeof val === "object") {
        collectRefs(val);
      }
    }
  }

  // Skip the "use sandbox" directive and collect from remaining statements
  for (const stmt of body.stmts.slice(1)) {
    collectRefs(stmt);
  }

  // Filter: keep only those that are:
  // 1. Referenced but not locally declared
  // 2. AND exist in some parent scope
  const closureVars: string[] = [];
  for (const name of referenced) {
    if (locallyDeclared.has(name)) continue;
    if (isBuiltIn(name)) continue;
    if (isDeclaredInScope(name, parentScope)) {
      closureVars.push(name);
    }
  }

  return closureVars.sort();
}

function isDeclaredInScope(name: string, scope: ScopeInfo | null): boolean {
  while (scope) {
    if (scope.declared.has(name)) return true;
    scope = scope.parent;
  }
  return false;
}

function isBuiltIn(name: string): boolean {
  const builtins = new Set([
    // Globals
    "undefined",
    "null",
    "true",
    "false",
    "NaN",
    "Infinity",
    "globalThis",
    "console",
    "process",
    "Buffer",
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
    // Common globals
    "Promise",
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "Function",
    "Symbol",
    "Error",
    "TypeError",
    "ReferenceError",
    "JSON",
    "Math",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Proxy",
    "Reflect",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "setImmediate",
    "clearImmediate",
    "queueMicrotask",
  ]);
  return builtins.has(name);
}

// ============================================================================
// Code Generation
// ============================================================================

function generateStub(fn: SandboxFunction): string {
  const { fnId, originalName, params, closureVars, isAsync, scopePath } = fn;

  const asyncKeyword = isAsync ? "async " : "";
  const paramList = params.join(", ");
  const argsArray = params.length > 0 ? `[${params.join(", ")}]` : "[]";

  // For nested functions, we need to pass closure vars
  let closureArg = "";
  if (closureVars.length > 0) {
    closureArg = `,\n    closureVars: { ${closureVars.join(", ")} }`;
  }

  // Determine if this is top-level or nested
  const isTopLevel = scopePath.length === 1;

  if (isTopLevel) {
    // Top-level function: replace the entire function
    return `${asyncKeyword}function ${originalName}(${paramList}) {
  return __sandbox_runSandboxFn({
    fnId: "${fnId}",
    args: ${argsArray}${closureArg}
  });
}`;
  } else {
    // Nested function: just the expression
    return `(${paramList}) => __sandbox_runSandboxFn({
  fnId: "${fnId}",
  args: ${argsArray}${closureArg}
})`;
  }
}

/**
 * Reconstruct an import statement from AST (handles multi-line imports properly).
 */
function reconstructImport(
  item: import("@swc/core").ImportDeclaration
): string {
  const specifiers = item.specifiers;
  const source = item.source.value;

  if (specifiers.length === 0) {
    return `import "${source}";`;
  }

  const defaultImport: string[] = [];
  const namedImports: string[] = [];
  let namespaceImport = "";

  for (const spec of specifiers) {
    if (spec.type === "ImportDefaultSpecifier") {
      defaultImport.push(spec.local.value);
    } else if (spec.type === "ImportNamespaceSpecifier") {
      namespaceImport = `* as ${spec.local.value}`;
    } else if (spec.type === "ImportSpecifier") {
      const imported = spec.imported?.value ?? spec.local.value;
      const local = spec.local.value;
      if (imported === local) {
        namedImports.push(imported);
      } else {
        namedImports.push(`${imported} as ${local}`);
      }
    }
  }

  const parts: string[] = [];
  if (defaultImport.length > 0) {
    parts.push(defaultImport[0]);
  }
  if (namespaceImport) {
    parts.push(namespaceImport);
  }
  if (namedImports.length > 0) {
    parts.push(`{ ${namedImports.join(", ")} }`);
  }

  return `import ${parts.join(", ")} from "${source}";`;
}

/**
 * Extract imports from AST for the sandbox file.
 *
 * We include ALL imports and let esbuild handle tree-shaking.
 * The only special case is @use-sandbox/core → rewrite to @use-sandbox/core/shell
 * to avoid bundling the runtime (which depends on @vercel/sandbox).
 */
function extractRelevantImports(module: Module): string[] {
  const imports: string[] = [];

  for (const item of module.body) {
    if (item.type === "ImportDeclaration") {
      // Skip type-only imports (they don't exist at runtime)
      if (item.typeOnly) continue;

      const source = item.source.value;

      // Special case: @use-sandbox/core needs to be rewritten to avoid bundling the runtime
      // The runtime imports @vercel/sandbox which shouldn't be in the sandbox bundle
      if (source === "@use-sandbox/core") {
        // Only rewrite $ to the shell subpath, skip other imports
        for (const spec of item.specifiers) {
          if (spec.type === "ImportSpecifier" && spec.local.value === "$") {
            imports.push(`import { $ } from "@use-sandbox/core/shell";`);
          }
          // Other imports like defineSandbox, __runSandboxFn etc. are skipped
          // because they're server-side only
        }
        continue;
      }

      // Include everything else - let esbuild tree-shake what's not used
      imports.push(reconstructImport(item));
    }
  }

  return imports;
}

function generateSandboxFile(
  fns: SandboxFunction[],
  originalPath: string,
  module: Module
): string {
  const lines: string[] = [
    `// Auto-generated sandbox file for ${basename(originalPath)}`,
    `// Do not edit directly - regenerated on build`,
    "",
  ];

  // Extract imports using AST (handles multi-line imports properly)
  const imports = extractRelevantImports(module);
  lines.push(...imports);
  lines.push("");

  // Add each function
  for (const fn of fns) {
    lines.push(fn.fullSource);
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================================
// Main Transform
// ============================================================================

export async function transform(
  source: string,
  filename: string
): Promise<TransformResult> {
  // Quick check
  if (!source.includes("use sandbox")) {
    return {
      code: source,
      hasSandboxFunctions: false,
      sandboxFilePath: null,
      sandboxFileContent: null,
    };
  }

  const byteToCharMap = createByteToCharMap(source);

  const module = await parse(source, {
    syntax:
      filename.endsWith(".tsx") || filename.endsWith(".ts")
        ? "typescript"
        : "ecmascript",
    tsx: filename.endsWith(".tsx"),
    jsx: filename.endsWith(".jsx"),
  });

  // Detect base offset (SWC may use global positions)
  let baseOffset = 0;
  if (module.body.length > 0) {
    const firstStart = module.body[0].span?.start ?? 1;
    if (firstStart > byteToCharMap.length) {
      baseOffset = firstStart - 1;
    }
  }

  const byteToChar = (pos: number): number => {
    const adjusted = pos - baseOffset;
    if (adjusted < 0 || adjusted >= byteToCharMap.length) return 0;
    return byteToCharMap[adjusted];
  };

  const ctx: WalkContext = {
    source,
    byteToChar,
    currentScope: { declared: new Set(), parent: null },
    scopePath: [],
    sandboxFunctions: [],
  };

  walkModule(module, ctx);

  if (ctx.sandboxFunctions.length === 0) {
    return {
      code: source,
      hasSandboxFunctions: false,
      sandboxFilePath: null,
      sandboxFileContent: null,
    };
  }

  // Generate .sandbox.ts content
  const sandboxContent = generateSandboxFile(
    ctx.sandboxFunctions,
    filename,
    module
  );

  // Generate transformed source with stubs
  const replacements = ctx.sandboxFunctions
    .filter((fn) => fn.scopePath.length === 1) // Only top-level for now
    .map((fn) => ({
      start: fn.location.start,
      end: fn.location.end,
      replacement: generateStub(fn),
    }))
    .sort((a, b) => b.start - a.start);

  let result = source;
  for (const { start, end, replacement } of replacements) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  // Add import
  const importStmt = `import { __runSandboxFn as __sandbox_runSandboxFn } from "@use-sandbox/core/runtime";\n`;
  result = importStmt + result;

  // Compute sandbox file path
  const sandboxFilePath = filename.replace(/\.(tsx?|jsx?)$/, ".sandbox.ts");

  return {
    code: result,
    hasSandboxFunctions: true,
    sandboxFilePath,
    sandboxFileContent: sandboxContent,
  };
}

/**
 * Write the sandbox file to disk.
 */
export function writeSandboxFile(
  sandboxFilePath: string,
  content: string
): void {
  const dir = dirname(sandboxFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(sandboxFilePath, content);
}
