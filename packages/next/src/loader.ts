/**
 * JS Loader for transforming "use sandbox" and "use exec" directives.
 * 
 * This loader performs simple AST-like string transformations to:
 * 1. Wrap "use sandbox" function bodies with runInSandbox()
 * 2. Transform "use exec" function bodies to execute in the sandbox
 */

// Regex patterns for directive detection
const USE_SANDBOX_REGEX = /['"]use sandbox['"]\s*;?/;
const USE_EXEC_REGEX = /['"]use exec['"]\s*;?/;

/**
 * Find the matching closing brace for a function body
 */
function findClosingBrace(code: string, startIndex: number): number {
  let depth = 1;
  let i = startIndex;
  
  while (i < code.length && depth > 0) {
    const char = code[i];
    
    // Handle string literals
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      i++;
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 2; // Skip escaped character
          continue;
        }
        if (code[i] === quote) {
          break;
        }
        // Handle template literal expressions
        if (quote === '`' && code[i] === '$' && code[i + 1] === '{') {
          i += 2;
          let templateDepth = 1;
          while (i < code.length && templateDepth > 0) {
            if (code[i] === '{') templateDepth++;
            else if (code[i] === '}') templateDepth--;
            i++;
          }
          continue;
        }
        i++;
      }
    }
    // Handle comments
    else if (char === '/' && code[i + 1] === '/') {
      // Single line comment
      while (i < code.length && code[i] !== '\n') {
        i++;
      }
    }
    else if (char === '/' && code[i + 1] === '*') {
      // Multi-line comment
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }
    else if (char === '{') {
      depth++;
    }
    else if (char === '}') {
      depth--;
    }
    
    i++;
  }
  
  return i - 1; // Return index of the closing brace
}

/**
 * Check if a function body starts with a directive (within first few lines)
 */
function getDirective(body: string): 'sandbox' | 'exec' | null {
  // Get the first meaningful line (skip whitespace and comments)
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      continue;
    }
    if (USE_SANDBOX_REGEX.test(trimmed)) {
      return 'sandbox';
    }
    if (USE_EXEC_REGEX.test(trimmed)) {
      return 'exec';
    }
    // First non-comment, non-empty line is not a directive
    break;
  }
  return null;
}

/**
 * Remove the directive from the function body
 */
function removeDirective(body: string, regex: RegExp): string {
  return body.replace(regex, '');
}

type FunctionMatch = {
  name: string;
  params: string;
  body: string;
  startIndex: number;
  endIndex: number;
  isExport: boolean;
  isDefault: boolean;
  directive: 'sandbox' | 'exec';
};

/**
 * Find all async functions with directives in the source
 */
function findFunctionsWithDirectives(source: string): FunctionMatch[] {
  const functions: FunctionMatch[] = [];
  const seenRanges = new Set<string>(); // Track seen startIndex:endIndex ranges
  
  // Patterns to match different function syntaxes
  // Order matters - more specific patterns first
  const patterns = [
    // export default async function name(...) {
    { regex: /export\s+default\s+async\s+function\s*(\w*)\s*\(([^)]*)\)\s*\{/g, isExport: true, isDefault: true },
    // export async function name(...) {
    { regex: /export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)\s*\{/g, isExport: true, isDefault: false },
    // async function name(...) { - but NOT after export (use negative lookbehind)
    { regex: /(?<!export\s+)(?<!export\s+default\s+)async\s+function\s+(\w+)\s*\(([^)]*)\)\s*\{/g, isExport: false, isDefault: false },
  ];

  for (const { regex, isExport, isDefault } of patterns) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      const startIndex = match.index;
      const matchEnd = startIndex + match[0].length;
      const openBraceIndex = matchEnd - 1; // The { is at the end of the match
      
      const closeBraceIndex = findClosingBrace(source, openBraceIndex + 1);
      const body = source.slice(openBraceIndex + 1, closeBraceIndex);
      
      const directive = getDirective(body);
      
      if (directive) {
        // Check if we've already seen this exact range (avoid duplicates)
        const rangeKey = `${startIndex}:${closeBraceIndex}`;
        if (seenRanges.has(rangeKey)) {
          continue;
        }
        seenRanges.add(rangeKey);
        
        functions.push({
          name: match[1] || '__default',
          params: match[2],
          body,
          startIndex,
          endIndex: closeBraceIndex,
          isExport,
          isDefault,
          directive,
        });
      }
    }
  }

  // Filter out any remaining nested/overlapping functions
  functions.sort((a, b) => a.startIndex - b.startIndex);
  
  const nonOverlapping: FunctionMatch[] = [];
  for (const fn of functions) {
    // Check if this function overlaps with any previous function
    const overlaps = nonOverlapping.some(
      prev => (fn.startIndex >= prev.startIndex && fn.startIndex <= prev.endIndex) ||
              (fn.endIndex >= prev.startIndex && fn.endIndex <= prev.endIndex)
    );
    if (!overlaps) {
      nonOverlapping.push(fn);
    }
  }

  // Sort by endIndex descending for safe replacement
  return nonOverlapping.sort((a, b) => b.startIndex - a.startIndex);
}

/**
 * Transform a function with "use sandbox" directive
 */
function transformSandboxFunction(fn: FunctionMatch): string {
  const cleanBody = removeDirective(fn.body, USE_SANDBOX_REGEX);
  const exportPrefix = fn.isExport ? (fn.isDefault ? 'export default ' : 'export ') : '';
  const fnName = fn.isDefault && !fn.name ? '' : fn.name;
  
  return `${exportPrefix}async function ${fnName}(${fn.params}) {
  return __sandbox_runInSandbox(async () => {${cleanBody}});
}`;
}

/**
 * Transform a function with "use exec" directive
 */
function transformExecFunction(fn: FunctionMatch): string {
  const cleanBody = removeDirective(fn.body, USE_EXEC_REGEX);
  const codeToExecute = cleanBody.trim();
  const exportPrefix = fn.isExport ? (fn.isDefault ? 'export default ' : 'export ') : '';
  const fnName = fn.isDefault && !fn.name ? '' : fn.name;
  
  // Create parameter destructuring for the sandbox execution
  const paramList = fn.params.split(',').map(p => p.trim()).filter(Boolean);
  const paramNames = paramList.map(p => {
    // Handle typed params like "path: string" -> "path"
    return p.split(':')[0].trim().split('=')[0].trim();
  });
  
  const argsObject = paramNames.length > 0 
    ? `{ ${paramNames.join(', ')} }`
    : '{}';
  
  const destructure = paramNames.length > 0 
    ? `const { ${paramNames.join(', ')} } = __args;\n  ` 
    : '';

  // Escape the code for use as a string literal
  const escapedCode = codeToExecute
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
  
  return `${exportPrefix}async function ${fnName}(${fn.params}) {
  return __sandbox_execInSandbox(\`${destructure}${escapedCode}\`, ${argsObject});
}`;
}

/**
 * Main transformation function
 */
function transformCode(source: string): { code: string; hasSandbox: boolean; hasExec: boolean } {
  const functions = findFunctionsWithDirectives(source);
  
  let code = source;
  let hasSandbox = false;
  let hasExec = false;
  
  // Apply transformations from end to start to preserve indices
  for (const fn of functions) {
    let replacement: string;
    
    if (fn.directive === 'sandbox') {
      hasSandbox = true;
      replacement = transformSandboxFunction(fn);
    } else {
      hasExec = true;
      replacement = transformExecFunction(fn);
    }
    
    code = code.slice(0, fn.startIndex) + replacement + code.slice(fn.endIndex + 1);
  }
  
  return { code, hasSandbox, hasExec };
}

/**
 * Webpack/Turbopack loader for sandbox directive transformation
 */
export default async function sandboxLoader(
  source: string | Buffer
): Promise<string> {
  const normalizedSource = source.toString();
  
  // Quick check - skip if no directives present
  if (!normalizedSource.includes('use sandbox') && !normalizedSource.includes('use exec')) {
    return normalizedSource;
  }
  
  const { code, hasSandbox, hasExec } = transformCode(normalizedSource);
  
  // Add imports if needed
  const imports: string[] = [];
  
  if (hasSandbox) {
    imports.push('import { runInSandbox as __sandbox_runInSandbox } from "@use-sandbox/core/runtime";');
  }
  
  if (hasExec) {
    imports.push('import { execInSandbox as __sandbox_execInSandbox } from "@use-sandbox/core/runtime";');
  }
  
  if (imports.length === 0) {
    return normalizedSource;
  }
  
  // Prepend imports to the code
  return imports.join('\n') + '\n' + code;
}
