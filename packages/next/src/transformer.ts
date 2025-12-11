/**
 * AST Transformer for "use sandbox" directive using @swc/core.
 *
 * Transforms functions with "use sandbox" directive into:
 * 1. A server-side stub that orchestrates sandbox execution
 * 2. An extracted function body that gets bundled for sandbox execution
 */

import { parse } from "@swc/core";
import type {
  ModuleItem,
  Statement,
  FunctionDeclaration,
  FunctionExpression,
  BlockStatement,
  ExpressionStatement,
  CallExpression,
  Identifier,
  ExportDeclaration,
  ExportDefaultDeclaration,
  Pattern,
  Param,
  ObjectPattern,
  ArrayPattern,
  RestElement,
  AssignmentPattern,
} from "@swc/core";
import { createHash } from "crypto";
import { registerSandboxFunction } from "./registry";

export interface TransformResult {
  code: string;
  hasSandboxFunctions: boolean;
  extractedFunctions: ExtractedFunction[];
}

export interface ExtractedFunction {
  fnId: string;
  fnName: string;
  params: string[];
  body: string;
  sourceFile: string;
}

/**
 * Creates a mapping from SWC byte offsets to JavaScript string character indices.
 * SWC uses 1-indexed byte offsets, but JS strings use 0-indexed UTF-16 code unit indices.
 *
 * Important: JavaScript strings are UTF-16, so characters outside BMP (like emojis)
 * take 2 code units. We need to map byte offsets to UTF-16 code unit indices.
 */
function createByteToCharMap(source: string): number[] {
  const buffer = Buffer.from(source, "utf-8");
  const map: number[] = new Array(buffer.length + 2); // +2 for 1-indexing and end

  let codeUnitIndex = 0; // UTF-16 code unit index (what String.slice uses)
  let byteIndex = 0;

  // map[0] is unused (SWC uses 1-indexed)
  map[0] = 0;

  for (const codePoint of source) {
    const charByteLength = Buffer.byteLength(codePoint, "utf-8");
    const charCodeUnitLength = codePoint.length; // 1 for BMP, 2 for surrogate pairs

    // Map each byte of this character to the starting code unit index
    for (let i = 0; i < charByteLength; i++) {
      map[byteIndex + 1] = codeUnitIndex; // +1 for 1-indexed
      byteIndex++;
    }
    codeUnitIndex += charCodeUnitLength;
  }

  // Handle the end position
  map[byteIndex + 1] = codeUnitIndex;

  return map;
}

function generateFnId(fnName: string, body: string): string {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
  return `${fnName}_${hash}`;
}

function isUseSandboxDirective(stmt: Statement): boolean {
  if (stmt.type !== "ExpressionStatement") return false;
  const expr = (stmt as ExpressionStatement).expression;
  if (expr.type !== "StringLiteral") return false;
  return expr.value === "use sandbox";
}

function isSandboxConfigCall(stmt: Statement): stmt is ExpressionStatement {
  if (stmt.type !== "ExpressionStatement") return false;
  const expr = (stmt as ExpressionStatement).expression;
  if (expr.type !== "CallExpression") return false;
  const callee = (expr as CallExpression).callee;
  if (callee.type !== "Identifier") return false;
  return (callee as Identifier).value === "sandboxConfig";
}

function extractParamNames(params: (Param | Pattern)[]): string[] {
  const names: string[] = [];

  function extractFromPattern(pattern: Pattern): void {
    switch (pattern.type) {
      case "Identifier":
        names.push((pattern as Identifier).value);
        break;
      case "ObjectPattern":
        for (const prop of (pattern as ObjectPattern).properties) {
          if (prop.type === "KeyValuePatternProperty") {
            extractFromPattern(prop.value);
          } else if (prop.type === "AssignmentPatternProperty") {
            names.push(prop.key.value);
          } else if (prop.type === "RestElement") {
            extractFromPattern((prop as RestElement).argument);
          }
        }
        break;
      case "ArrayPattern":
        for (const elem of (pattern as ArrayPattern).elements) {
          if (elem) extractFromPattern(elem);
        }
        break;
      case "RestElement":
        extractFromPattern((pattern as RestElement).argument);
        break;
      case "AssignmentPattern":
        extractFromPattern((pattern as AssignmentPattern).left);
        break;
    }
  }

  for (const param of params) {
    if ("pat" in param) {
      extractFromPattern((param as Param).pat);
    } else {
      extractFromPattern(param as Pattern);
    }
  }

  return names;
}

interface HasSpan {
  span: { start: number; end: number };
}

type ByteToCharFn = (bytePos: number) => number;

function getParamsSource(
  params: (Param | Pattern)[],
  source: string,
  byteToChar: ByteToCharFn
): string {
  if (params.length === 0) return "";
  const first = params[0];
  const last = params[params.length - 1];

  const getSpan = (p: Param | Pattern): { start: number; end: number } => {
    if ("pat" in p) {
      const pat = (p as Param).pat;
      return (pat as unknown as HasSpan).span;
    }
    return (p as unknown as HasSpan).span;
  };

  const startSpan = getSpan(first);
  const endSpan = getSpan(last);

  return source.slice(byteToChar(startSpan.start), byteToChar(endSpan.end));
}

interface FunctionInfo {
  name: string;
  params: (Param | Pattern)[];
  body: BlockStatement;
  isAsync: boolean;
  isExport: boolean;
  isDefaultExport: boolean;
  startOffset: number;
  endOffset: number;
}

function extractFunctionInfoWithOffset(
  stmt: ModuleItem,
  byteToChar: ByteToCharFn
): FunctionInfo | null {
  let fnDecl: FunctionDeclaration | FunctionExpression | null = null;
  let isExport = false;
  let isDefaultExport = false;

  if (stmt.type === "FunctionDeclaration") {
    fnDecl = stmt as FunctionDeclaration;
  } else if (stmt.type === "ExportDeclaration") {
    const exportDecl = stmt as ExportDeclaration;
    if (exportDecl.declaration.type === "FunctionDeclaration") {
      fnDecl = exportDecl.declaration as FunctionDeclaration;
      isExport = true;
    }
  } else if (stmt.type === "ExportDefaultDeclaration") {
    const exportDefault = stmt as ExportDefaultDeclaration;
    if (exportDefault.decl.type === "FunctionExpression") {
      const fnExpr = exportDefault.decl as FunctionExpression;
      isExport = true;
      isDefaultExport = true;
      return {
        name: fnExpr.identifier?.value || "__default",
        params: fnExpr.params,
        body: fnExpr.body!,
        isAsync: fnExpr.async,
        isExport,
        isDefaultExport,
        startOffset: byteToChar(stmt.span.start),
        endOffset: byteToChar(stmt.span.end),
      };
    }
  }

  if (!fnDecl) return null;
  if (!fnDecl.body) return null;

  const parentStmt = stmt as ModuleItem & {
    span: { start: number; end: number };
  };
  return {
    name: fnDecl.identifier.value,
    params: fnDecl.params,
    body: fnDecl.body,
    isAsync: fnDecl.async,
    isExport,
    isDefaultExport,
    startOffset: byteToChar(parentStmt.span.start),
    endOffset: byteToChar(parentStmt.span.end),
  };
}

function hasSandboxDirective(body: BlockStatement): boolean {
  if (body.stmts.length === 0) return false;
  return isUseSandboxDirective(body.stmts[0]);
}

interface ParsedSandboxFunction {
  fnInfo: FunctionInfo;
  configCallSource: string | null;
  remainingBodySource: string;
}

function parseSandboxFunction(
  fnInfo: FunctionInfo,
  source: string,
  byteToChar: ByteToCharFn
): ParsedSandboxFunction {
  const stmts = fnInfo.body.stmts;
  let configCallSource: string | null = null;
  let bodyStartIndex = 1; // Skip the "use sandbox" directive

  // Check if second statement is sandboxConfig()
  if (stmts.length > 1 && isSandboxConfigCall(stmts[1])) {
    const configStmt = stmts[1] as ExpressionStatement;
    configCallSource = source.slice(
      byteToChar(configStmt.span.start),
      byteToChar(configStmt.span.end)
    );
    bodyStartIndex = 2;
  }

  // Extract remaining body
  if (stmts.length > bodyStartIndex) {
    const firstRemaining = stmts[bodyStartIndex];
    const lastStmt = stmts[stmts.length - 1];
    const remainingBodySource = source.slice(
      byteToChar(firstRemaining.span.start),
      byteToChar(lastStmt.span.end)
    );
    return { fnInfo, configCallSource, remainingBodySource };
  }

  return { fnInfo, configCallSource, remainingBodySource: "" };
}

function generateServerStub(
  parsed: ParsedSandboxFunction,
  fnId: string,
  source: string,
  byteToChar: ByteToCharFn
): string {
  const { fnInfo, configCallSource } = parsed;
  const exportPrefix = fnInfo.isExport
    ? fnInfo.isDefaultExport
      ? "export default "
      : "export "
    : "";
  const fnName = fnInfo.isDefaultExport ? "" : fnInfo.name;
  const paramsSource = getParamsSource(fnInfo.params, source, byteToChar);
  const paramNames = extractParamNames(fnInfo.params);
  const argsArray = paramNames.length > 0 ? `[${paramNames.join(", ")}]` : "[]";

  // Extract config from sandboxConfig() call or use empty object
  let configSource = "{}";
  if (configCallSource) {
    // Extract the object literal from sandboxConfig({ ... })
    const match = configCallSource.match(
      /sandboxConfig\s*\(\s*(\{[\s\S]*\})\s*\)/
    );
    if (match) {
      configSource = match[1];
    }
  }

  return `${exportPrefix}async function ${fnName}(${paramsSource}) {
  return __sandbox_runSandboxFn({
    fnId: "${fnId}",
    config: ${configSource},
    args: ${argsArray}
  });
}`;
}

export async function transform(
  source: string,
  filename: string
): Promise<TransformResult> {
  // Quick check - skip if no directive present
  if (!source.includes("use sandbox")) {
    return {
      code: source,
      hasSandboxFunctions: false,
      extractedFunctions: [],
    };
  }

  // Create byte-to-char mapping for proper offset handling
  const byteToChar = createByteToCharMap(source);

  const module = await parse(source, {
    syntax:
      filename.endsWith(".tsx") || filename.endsWith(".ts")
        ? "typescript"
        : "ecmascript",
    tsx: filename.endsWith(".tsx"),
    jsx: filename.endsWith(".jsx"),
  });

  const extractedFunctions: ExtractedFunction[] = [];
  const replacements: Array<{
    start: number;
    end: number;
    replacement: string;
  }> = [];

  // Detect base offset: SWC may use global byte positions instead of file-relative
  // Find the minimum span.start across all statements to determine the base offset
  let baseOffset = 0;
  if (module.body.length > 0) {
    const firstSpanStart = module.body[0].span?.start ?? 1;
    if (firstSpanStart > byteToChar.length) {
      // Spans are beyond source length, need to adjust
      baseOffset = firstSpanStart - 1; // -1 because spans are 1-indexed
    }
  }

  // Create adjusted byte-to-char lookup that accounts for base offset
  const adjustedByteToChar = (bytePos: number): number => {
    const adjustedPos = bytePos - baseOffset;
    if (adjustedPos < 0 || adjustedPos >= byteToChar.length) {
      return 0;
    }
    return byteToChar[adjustedPos];
  };

  for (const stmt of module.body) {
    const fnInfo = extractFunctionInfoWithOffset(stmt, adjustedByteToChar);
    if (!fnInfo) continue;
    if (!hasSandboxDirective(fnInfo.body)) continue;

    const parsed = parseSandboxFunction(fnInfo, source, adjustedByteToChar);
    const fnId = generateFnId(fnInfo.name, parsed.remainingBodySource);

    const serverStub = generateServerStub(
      parsed,
      fnId,
      source,
      adjustedByteToChar
    );

    extractedFunctions.push({
      fnId,
      fnName: fnInfo.name,
      params: extractParamNames(fnInfo.params),
      body: "", // Body is no longer extracted - esbuild handles it
      sourceFile: filename,
    });

    // Register for bundling (just metadata, esbuild will read the source)
    registerSandboxFunction(fnId, fnInfo.name, filename);

    replacements.push({
      start: fnInfo.startOffset,
      end: fnInfo.endOffset,
      replacement: serverStub,
    });
  }

  if (replacements.length === 0) {
    return {
      code: source,
      hasSandboxFunctions: false,
      extractedFunctions: [],
    };
  }

  // Apply replacements from end to start to preserve offsets
  replacements.sort((a, b) => b.start - a.start);
  let result = source;
  for (const { start, end, replacement } of replacements) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  // Add import for __sandbox_runSandboxFn
  const importStatement = `import { __runSandboxFn as __sandbox_runSandboxFn } from "@use-sandbox/core/runtime";\n`;
  result = importStatement + result;

  return {
    code: result,
    hasSandboxFunctions: true,
    extractedFunctions,
  };
}
