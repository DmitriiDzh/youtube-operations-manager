import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

// BL-152: finds English written straight into the Web UI (.tsx and .ts under src/components and src/app, except the API
// routes) -- JSX text, text attributes (title, placeholder, aria-label,
// alt, label…), and sentence-like strings anywhere in a .tsx file. Used by `src/lib/ui-text/literal-text.inventory.test.ts`.
// A string that is not interface text is marked on its line (or the line above) with `ui-text-ignore` and a reason.

export const ROOTS = ["src/components", "src/app"];

// Attributes whose value is never shown to a person.
const TECHNICAL_ATTRIBUTES = new Set([
  "className", "key", "href", "id", "type", "name", "role", "src", "value", "defaultValue", "htmlFor", "list", "inputMode",
  "autoComplete", "target", "rel", "method", "action", "viewBox", "fill", "stroke", "d", "strokeLinecap", "strokeLinejoin",
  "xmlns", "accept", "pattern", "lang", "dir", "spellCheck", "wrap", "aria-hidden", "aria-live", "aria-controls",
  "aria-describedby", "aria-labelledby", "aria-current", "aria-haspopup", "aria-expanded", "aria-selected", "data-testid",
  "maxWidthClass", "loading", "decoding", "crossOrigin", "preload", "encType", "tabIndex", "variant", "confirmVariant",
  "color", "size", "side", "kind", "mode", "tone", "status", "align", "sizes", "download",
]);

export async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // API routes answer agents and scripts too: their bodies stay English (AGENTS.md §B); the UI translates them by code.
    if (entry.isDirectory()) {
      if (path.relative(process.cwd(), full).split(path.sep).join("/") !== "src/app/api") out.push(...(await sourceFiles(full)));
    }
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const hasWord = (text: string) => /[A-Za-z]{2,}/.test(text);
// A sentence or a label: a capitalized word followed by more text, or several words ending in sentence punctuation.
const looksLikeProse = (text: string) => /^[A-Z][a-z]+[\s,.:;!?…'’)-]/.test(text.trim()) || /^[A-Z][a-z]+$/.test(text.trim()) && text.trim().length > 3 || (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text) && /[.!?…:]$/.test(text.trim()) && !/[a-z]+-[a-z0-9]+/.test(text));

function attributeName(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return p.name.getText();
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isBlock(p) || ts.isSourceFile(p)) return null;
  }
  return null;
}

function isIgnoredContext(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isTypeNode(p) || ts.isLiteralTypeNode(p)) return true;
    if (ts.isCallExpression(p)) {
      const callee = p.expression.getText();
      // Developer output, network addresses and plain comparisons are not interface text.
      if (/^console\.|^fetch$|\.(startsWith|endsWith|includes|indexOf|split|replace|replaceAll|match|test|get|set|has|getItem|setItem)$|^t$|^translate$|^(useT|useUiText)$/.test(callee)) return true;
    }
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(p.operatorToken.kind)) return true;
    if (ts.isPropertyAssignment(p) && p.name === node) return true;
    if (ts.isCaseClause(p) && p.expression === node) return true;
    if (ts.isElementAccessExpression(p)) return true;
    if (ts.isBlock(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

export function literalTextOffenders(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split("\n");
  const ignored = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return /ui-text-ignore/.test(lines[line] ?? "") || /ui-text-ignore/.test(lines[line - 1] ?? "");
  };
  const found: string[] = [];
  const report = (node: ts.Node, text: string) => {
    if (ignored(node)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push(`${line + 1}: ${text.trim().replace(/\s+/g, " ").slice(0, 70)}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText().replace(/&[a-z]+;|&#\d+;/g, " ");
      if (hasWord(text)) report(node, text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ") : node.text;
      const attr = attributeName(node);
      if (attr !== null) {
        if (!TECHNICAL_ATTRIBUTES.has(attr) && hasWord(text) && (looksLikeProse(text) || /\s/.test(text.trim()))) report(node, text);
      } else if (!isIgnoredContext(node) && looksLikeProse(text)) {
        report(node, text);
      }
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every offender under ROOTS, keyed by repository-relative path (files with none are left out). */
export async function scanLiteralText(cwd: string = process.cwd()): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const root of ROOTS) {
    for (const file of await sourceFiles(path.join(cwd, root))) {
      const rel = path.relative(cwd, file).split(path.sep).join("/");
      const found = literalTextOffenders(rel, await readFile(file, "utf8"));
      if (found.length > 0) out.set(rel, found);
    }
  }
  return out;
}
