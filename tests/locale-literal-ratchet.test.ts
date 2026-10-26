import ts from "typescript";
import { describe, expect, it } from "vitest";

// Keep Node built-ins typed locally: the Worker project does not include @types/node.
const fsModule: string = "node:fs";
const { readFileSync, readdirSync } = await import(fsModule) as {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL): string[];
};

// Count a ternary once when its condition contains locale.code === "es",
// including compound conditions. Cached flags and ordinary comparisons are excluded.
// Ceiling measured at origin/main fceb4b1. Consolidation may lower these counts;
// increases belong in locale.ts instead of raising this baseline.
const baseline: Readonly<Record<string, number>> = {
  "arrival-managers.ts": 1,
  "cl-history.ts": 0,
  "comparison.ts": 0,
  "layout.ts": 10,
  "manager-eras.ts": 0,
  "opponent-history.ts": 0,
  "pages.ts": 13,
  "player-range.ts": 0,
  "player-trends.ts": 1,
  "season-splits.ts": 1
};

function countLocaleTernaries(source: string): number {
  const file = ts.createSourceFile("view.ts", source, ts.ScriptTarget.Latest, true);
  let count = 0;
  function containsSpanishChoice(node: ts.Node): boolean {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && ts.isIdentifier(node.left.expression)
      && node.left.expression.text === "locale"
      && node.left.name.text === "code"
      && ts.isStringLiteral(node.right) && node.right.text === "es") return true;
    let found = false;
    ts.forEachChild(node, (child) => { if (containsSpanishChoice(child)) found = true; });
    return found;
  }
  function visit(node: ts.Node): void {
    if (ts.isConditionalExpression(node) && containsSpanishChoice(node.condition)) count++;
    ts.forEachChild(node, visit);
  }
  visit(file);
  return count;
}

function increases(sources: Readonly<Record<string, string>>, ceilings = baseline): string[] {
  return Object.keys(sources).sort().flatMap((name) => {
    const actual = countLocaleTernaries(sources[name]!);
    const allowed = ceilings[name] ?? 0;
    return actual > allowed ? [`${name}: ${actual} > ${allowed}`] : [];
  });
}

const viewsDir = new URL("../worker/src/views/", import.meta.url);
const views = Object.fromEntries(readdirSync(viewsDir).filter((name) => name.endsWith(".ts"))
  .sort().map((name) => [name, readFileSync(new URL(name, viewsDir), "utf8")]));

describe("inline locale literal ratchet", () => {
  it("keeps every view within its committed per-file ceiling", () => {
    expect(Object.keys(views).length).toBeGreaterThan(0);
    expect(increases(views), viewsDir.pathname).toEqual([]);
  });

  it("permits consolidation below the baseline", () => {
    expect(increases({ "existing.ts": "const text = locale.labels.title;" }, { "existing.ts": 1 })).toEqual([]);
  });

  it("rejects one added ternary in a real view", () => {
    const name = "layout.ts";
    const added = views[name]! + '\nconst regression = locale.code === "es" ? "Nuevo" : "New";';
    expect(increases({ ...views, [name]: added })).toContain(`${name}: ${baseline[name]! + 1} > ${baseline[name]}`);
  });

  it("gives new view files a zero ceiling", () => {
    expect(increases({ "new-view.ts": 'const text = locale.code === "es" ? "Sí" : "Yes";' }))
      .toEqual(["new-view.ts: 1 > 0"]);
  });

  it("counts syntax across quotes, whitespace, parentheses and compound conditions", () => {
    expect(countLocaleTernaries(`
      const a = (locale.code === 'es') ? "A" : "B";
      const b = locale.code /* comment */ === "es"
        ? "C" : "D";
      const c = locale.code === "es" && credit ? credit : fallback;
    `)).toBe(3);
  });

  it("ignores comments, string content and non-ternary comparisons", () => {
    expect(countLocaleTernaries(`
      // locale.code === "es" ? "A" : "B"
      const example = 'locale.code === "es" ? "A" : "B"';
      const isSpanish = locale.code === "es";
      const other = item.code === "es" ? "A" : "B";
    `)).toBe(0);
  });
});
