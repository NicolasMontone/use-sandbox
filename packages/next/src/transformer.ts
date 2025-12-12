/**
 * Transformer V3: AST-mutation approach (inspired by Workflow).
 *
 * Key insight: Instead of string slicing with positions (which break in Turbopack
 * due to global positions), we mutate the AST directly and let SWC print it.
 *
 * Flow:
 * 1. Parse source → AST module
 * 2. Walk AST, collect sandbox function info + track AST node locations
 * 3. Replace sandbox function AST nodes with stub AST nodes
 * 4. printSync(modified module) → output code
 */

import { parse, parseSync, printSync } from "@swc/core";
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
  ExportDeclaration,
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
  /** Is this an async function? */
  isAsync: boolean;
  /** Location for AST replacement */
  astLocation: AstLocation;
}

type AstLocation =
  | { type: "module-item"; index: number }
  | { type: "export-decl"; index: number }
  | { type: "export-default"; index: number }
  | { type: "var-declarator"; moduleIndex: number; declIndex: number }
  | {
      type: "export-var-declarator";
      moduleIndex: number;
      declIndex: number;
    };

interface ScopeInfo {
  /** Variables declared in this scope */
  declared: Set<string>;
  /** Parent scope */
  parent: ScopeInfo | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a stable function ID based on file path and function name.
 * This ensures the ID doesn't change when the function body is edited,
 * which is critical for hot-reload to work correctly.
 */
function generateFnId(filename: string, scopePath: string[]): string {
  const fnName = scopePath.join("$");
  // Use file path + function name for stable ID (not code content)
  const stableKey = `${filename}/${fnName}`;
  const hash = hashString(stableKey);
  return `${fnName}_${hash}`;
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

/**
 * Print an AST node to source code using SWC's printer.
 */
function printAst(node: unknown): string {
  const wrapper = {
    type: "Module",
    span: { start: 0, end: 0, ctxt: 0 },
    body: Array.isArray(node) ? node : [node],
    interpreter: null,
  };

  try {
    const result = printSync(wrapper as any, {});
    return result.code.trim();
  } catch {
    return "";
  }
}

/**
 * Print function parameters to source code.
 */
function printParams(params: (Param | Pattern)[]): string {
  if (params.length === 0) return "";

  const normalizedParams = params.map((p) => {
    if ("pat" in p) {
      return { ...p, type: "Parameter" };
    }
    return {
      type: "Parameter",
      span: { start: 0, end: 0, ctxt: 0 },
      decorators: [],
      pat: p,
    };
  });

  const dummyFn = {
    type: "FunctionDeclaration",
    span: { start: 0, end: 0, ctxt: 0 },
    identifier: {
      type: "Identifier",
      span: { start: 0, end: 0, ctxt: 0 },
      value: "_",
      optional: false,
      ctxt: 0,
    },
    declare: false,
    params: normalizedParams,
    body: {
      type: "BlockStatement",
      span: { start: 0, end: 0, ctxt: 0 },
      stmts: [],
      ctxt: 0,
    },
    generator: false,
    async: false,
    typeParameters: null,
    returnType: null,
    ctxt: 0,
  };

  const wrapper = {
    type: "Module",
    span: { start: 0, end: 0, ctxt: 0 },
    body: [dummyFn],
    interpreter: null,
  };

  try {
    const result = printSync(wrapper as any, {});
    const match = result.code.match(/function\s+_\s*\(([^)]*)\)/);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
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
  currentScope: ScopeInfo;
  scopePath: string[];
  sandboxFunctions: SandboxFunction[];
  /** Relative file path for stable function IDs */
  filename: string;
}

/**
 * Walk the AST to find all sandbox functions, tracking AST locations.
 */
function walkModule(module: Module, ctx: WalkContext): void {
  for (let i = 0; i < module.body.length; i++) {
    walkModuleItem(module.body[i], i, ctx);
  }
}

function walkModuleItem(
  item: ModuleItem,
  index: number,
  ctx: WalkContext
): void {
  switch (item.type) {
    case "FunctionDeclaration":
      walkFunctionDecl(item, ctx, { type: "module-item", index });
      break;
    case "ExportDeclaration":
      if (item.declaration.type === "FunctionDeclaration") {
        walkFunctionDecl(item.declaration, ctx, { type: "export-decl", index });
      } else if (item.declaration.type === "VariableDeclaration") {
        walkVarDecl(item.declaration, ctx, index, true);
      }
      break;
    case "ExportDefaultDeclaration":
      if (item.decl.type === "FunctionExpression") {
        walkFunctionExpr(item.decl, ctx, "default", {
          type: "export-default",
          index,
        });
      }
      break;
    case "VariableDeclaration":
      walkVarDecl(item, ctx, index, false);
      break;
    default:
      if ("body" in item && item.body) {
        walkStatement(item as Statement, ctx);
      }
  }
}

function walkVarDecl(
  decl: VariableDeclaration,
  ctx: WalkContext,
  moduleIndex: number,
  isExport: boolean
): void {
  for (let i = 0; i < decl.declarations.length; i++) {
    const d = decl.declarations[i];
    if (d.id.type === "Identifier") {
      ctx.currentScope.declared.add(d.id.value);
    }

    if (d.init) {
      if (
        d.init.type === "FunctionExpression" ||
        d.init.type === "ArrowFunctionExpression"
      ) {
        const name = d.id.type === "Identifier" ? d.id.value : "anonymous";
        const loc: AstLocation = isExport
          ? { type: "export-var-declarator", moduleIndex, declIndex: i }
          : { type: "var-declarator", moduleIndex, declIndex: i };
        walkFunctionExpr(d.init, ctx, name, loc);
      } else {
        walkExpression(d.init, ctx);
      }
    }
  }
}

function walkFunctionDecl(
  fn: FunctionDeclaration,
  ctx: WalkContext,
  astLocation: AstLocation
): void {
  const name = fn.identifier.value;
  ctx.currentScope.declared.add(name);

  if (!fn.body) return;

  const hasSandbox =
    fn.body.stmts.length > 0 && isUseSandboxDirective(fn.body.stmts[0]);

  if (hasSandbox) {
    collectSandboxFunction(fn, fn.body, name, ctx, astLocation);
  } else {
    walkFunctionBody(fn.body, fn.params, name, ctx);
  }
}

function walkFunctionExpr(
  fn: FunctionExpression | ArrowFunctionExpression,
  ctx: WalkContext,
  name: string,
  astLocation: AstLocation
): void {
  const body = fn.body?.type === "BlockStatement" ? fn.body : null;

  if (!body) {
    if (
      fn.type === "ArrowFunctionExpression" &&
      fn.body?.type !== "BlockStatement"
    ) {
      walkExpression(fn.body as Expression, ctx);
    }
    return;
  }

  const hasSandbox =
    body.stmts.length > 0 && isUseSandboxDirective(body.stmts[0]);

  if (hasSandbox) {
    collectSandboxFunction(fn, body, name, ctx, astLocation);
  } else {
    walkFunctionBody(body, fn.params, name, ctx);
  }
}

function walkFunctionBody(
  body: BlockStatement,
  params: (Param | Pattern)[],
  fnName: string,
  ctx: WalkContext
): void {
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
      // Nested var decl - not tracking for replacement
      for (const d of stmt.declarations) {
        if (d.id.type === "Identifier") {
          ctx.currentScope.declared.add(d.id.value);
        }
        if (d.init) walkExpression(d.init, ctx);
      }
      break;
    case "FunctionDeclaration":
      // Nested function - not tracking for replacement yet
      ctx.currentScope.declared.add(stmt.identifier.value);
      if (stmt.body) {
        walkFunctionBody(stmt.body, stmt.params, stmt.identifier.value, ctx);
      }
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
        for (const d of stmt.init.declarations) {
          if (d.id.type === "Identifier") {
            ctx.currentScope.declared.add(d.id.value);
          }
          if (d.init) walkExpression(d.init, ctx);
        }
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
  }
}

function walkExpression(expr: Expression, ctx: WalkContext): void {
  switch (expr.type) {
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      // Nested function expressions - walk body but don't track for replacement
      const name =
        expr.type === "FunctionExpression" && expr.identifier
          ? expr.identifier.value
          : "anonymous";
      const body = expr.body?.type === "BlockStatement" ? expr.body : null;
      if (body) {
        walkFunctionBody(body, expr.params, name, ctx);
      }
      break;
    case "CallExpression":
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
  }
}

// ============================================================================
// Sandbox Function Collection
// ============================================================================

function collectSandboxFunction(
  fn: AnyFunction,
  body: BlockStatement,
  name: string,
  ctx: WalkContext,
  astLocation: AstLocation
): void {
  const scopePath = [...ctx.scopePath, name];
  const isNested = ctx.scopePath.length > 0;

  const paramNames = extractParamNames(fn.params);
  const paramsSource = printParams(fn.params);

  let closureVars: string[] = [];
  if (isNested) {
    closureVars = detectClosureVars(body, paramNames, ctx.currentScope);
  }

  const bodyStmts = body.stmts.slice(1);
  const bodySource = bodyStmts.length > 0 ? printAst(bodyStmts) : "";

  // Use stable function ID based on file path + function name (not code content)
  const fnId = generateFnId(ctx.filename, scopePath);

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
    isAsync: "async" in fn ? fn.async : true,
    astLocation,
  });
}

function detectClosureVars(
  body: BlockStatement,
  params: string[],
  parentScope: ScopeInfo
): string[] {
  const referenced = new Set<string>();
  const locallyDeclared = new Set<string>(params);

  function collectRefs(node: unknown): void {
    if (!node || typeof node !== "object") return;

    const n = node as Record<string, unknown>;

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

    if (n.type === "Identifier") {
      const id = n as unknown as Identifier;
      referenced.add(id.value);
      return;
    }

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

  for (const stmt of body.stmts.slice(1)) {
    collectRefs(stmt);
  }

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
// AST Mutation & Code Generation
// ============================================================================

/**
 * Parse a stub function into an AST FunctionDeclaration.
 */
function parseStubToAst(stubCode: string): FunctionDeclaration {
  const module = parseSync(stubCode, { syntax: "ecmascript" });
  const firstItem = module.body[0];
  if (firstItem.type === "FunctionDeclaration") {
    return firstItem;
  }
  throw new Error("Stub code did not produce a FunctionDeclaration");
}

/**
 * Parse a stub arrow function into an AST ArrowFunctionExpression.
 */
function parseArrowStubToAst(stubCode: string): ArrowFunctionExpression {
  // Wrap in a variable declaration to parse it
  const wrappedCode = `const _ = ${stubCode};`;
  const module = parseSync(wrappedCode, { syntax: "ecmascript" });
  const firstItem = module.body[0];
  if (firstItem.type === "VariableDeclaration") {
    const init = firstItem.declarations[0].init;
    if (init?.type === "ArrowFunctionExpression") {
      return init;
    }
  }
  throw new Error("Stub code did not produce an ArrowFunctionExpression");
}

function generateStubCode(fn: SandboxFunction): string {
  const { fnId, originalName, params, closureVars, isAsync, scopePath } = fn;

  const asyncKeyword = isAsync ? "async " : "";
  const paramList = params.join(", ");
  const argsArray = params.length > 0 ? `[${params.join(", ")}]` : "[]";

  let closureArg = "";
  if (closureVars.length > 0) {
    closureArg = `, closureVars: { ${closureVars.join(", ")} }`;
  }

  const isTopLevel = scopePath.length === 1;

  if (isTopLevel) {
    return `${asyncKeyword}function ${originalName}(${paramList}) {
  return __sandbox_runSandboxFn({
    fnId: "${fnId}",
    args: ${argsArray}${closureArg}
  });
}`;
  } else {
    return `(${paramList}) => __sandbox_runSandboxFn({
  fnId: "${fnId}",
  args: ${argsArray}${closureArg}
})`;
  }
}

/**
 * Apply AST mutations to replace sandbox functions with stubs.
 */
function applyAstMutations(
  module: Module,
  sandboxFunctions: SandboxFunction[]
): void {
  for (const fn of sandboxFunctions) {
    // Only handle top-level functions for now
    if (fn.scopePath.length !== 1) continue;

    const stubCode = generateStubCode(fn);
    const loc = fn.astLocation;

    switch (loc.type) {
      case "module-item": {
        const stubAst = parseStubToAst(stubCode);
        module.body[loc.index] = stubAst;
        break;
      }
      case "export-decl": {
        const stubAst = parseStubToAst(stubCode);
        const exportItem = module.body[loc.index] as ExportDeclaration;
        exportItem.declaration = stubAst;
        break;
      }
      case "export-default": {
        // For export default, we need to create a FunctionExpression stub
        const wrappedStub = stubCode.replace(
          /^async function \w+/,
          "async function"
        );
        const stubModule = parseSync(
          `export default ${wrappedStub.replace(
            /^function/,
            "async function"
          )}`,
          { syntax: "ecmascript" }
        );
        module.body[loc.index] = stubModule.body[0];
        break;
      }
      case "var-declarator": {
        const varDecl = module.body[loc.moduleIndex] as VariableDeclaration;
        const stubArrow = parseArrowStubToAst(
          `async (${fn.params.join(", ")}) => __sandbox_runSandboxFn({ fnId: "${
            fn.fnId
          }", args: [${fn.params.join(", ")}] })`
        );
        varDecl.declarations[loc.declIndex].init = stubArrow;
        break;
      }
      case "export-var-declarator": {
        const exportDecl = module.body[loc.moduleIndex] as ExportDeclaration;
        const varDecl = exportDecl.declaration as VariableDeclaration;
        const stubArrow = parseArrowStubToAst(
          `async (${fn.params.join(", ")}) => __sandbox_runSandboxFn({ fnId: "${
            fn.fnId
          }", args: [${fn.params.join(", ")}] })`
        );
        varDecl.declarations[loc.declIndex].init = stubArrow;
        break;
      }
    }
  }
}

/**
 * Add the runtime import to the module.
 */
function addRuntimeImport(module: Module): void {
  const importCode = `import { __runSandboxFn as __sandbox_runSandboxFn } from "@use-sandbox/core/runtime";`;
  const importModule = parseSync(importCode, { syntax: "ecmascript" });
  module.body.unshift(importModule.body[0]);
}

/**
 * Reconstruct an import statement from AST.
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
 * Extract imports for the sandbox file.
 */
function extractRelevantImports(module: Module): string[] {
  const imports: string[] = [];

  for (const item of module.body) {
    if (item.type === "ImportDeclaration") {
      if (item.typeOnly) continue;

      const source = item.source.value;

      if (source === "@use-sandbox/core") {
        for (const spec of item.specifiers) {
          if (spec.type === "ImportSpecifier" && spec.local.value === "$") {
            imports.push(`import { $ } from "@use-sandbox/core/shell";`);
          }
        }
        continue;
      }

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

  const imports = extractRelevantImports(module);
  lines.push(...imports);
  lines.push("");

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
  if (!source.includes("use sandbox")) {
    return {
      code: source,
      hasSandboxFunctions: false,
      sandboxFilePath: null,
      sandboxFileContent: null,
    };
  }

  const module = await parse(source, {
    syntax:
      filename.endsWith(".tsx") || filename.endsWith(".ts")
        ? "typescript"
        : "ecmascript",
    tsx: filename.endsWith(".tsx"),
    jsx: filename.endsWith(".jsx"),
  });

  // Normalize filename to relative path for stable IDs across environments
  const normalizedFilename = filename
    .replace(/\\/g, "/")
    .replace(/^.*?\/app\//, "app/")  // Keep from app/ onwards
    .replace(/^.*?\/src\//, "src/"); // Or from src/ onwards

  const ctx: WalkContext = {
    currentScope: { declared: new Set(), parent: null },
    scopePath: [],
    sandboxFunctions: [],
    filename: normalizedFilename,
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

  // Generate .sandbox.ts content BEFORE mutating the module
  const sandboxContent = generateSandboxFile(
    ctx.sandboxFunctions,
    filename,
    module
  );

  // Mutate the AST to replace sandbox functions with stubs
  applyAstMutations(module, ctx.sandboxFunctions);

  // Add runtime import
  addRuntimeImport(module);

  // Print the mutated module to get the output code
  const result = printSync(module, {});

  const sandboxFilePath = filename.replace(/\.(tsx?|jsx?)$/, ".sandbox.ts");

  return {
    code: result.code,
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
