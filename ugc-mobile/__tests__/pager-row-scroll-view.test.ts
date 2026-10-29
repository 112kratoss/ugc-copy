import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { SCROLLER, unwrap } from './fixtures/jsx-syntax';

/**
 * A sideways row drawn on a page of a sideways pager is a `PagerRowScrollView`.
 * On Android the pager took every sideways drag that began on a plain scroll
 * view there, so the Details page's references never moved under a finger
 * (Pixel 9a, 2026-10-29); `components/pager-row-scroll-view.tsx` says why its
 * scroll view keeps the drag and `nestedScrollEnabled` did not. No unit test
 * can see who takes a drag, so this one holds the rule in place: the pages
 * below are swept with every component they import, as far as the imports go,
 * and any other horizontal scroller on them fails.
 */
const PAGER_PAGES = [
  // The Details page: the viewer's last page, and the post screen's.
  'components/post-details-page.tsx',
];

/** The row itself, the one place a plain horizontal scroll view belongs. */
const ROW = 'components/pager-row-scroll-view.tsx';

const mobileRoot = path.resolve(__dirname, '..');

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(mobileRoot, specifier.slice(2))
    : specifier.startsWith('.') ? path.resolve(path.dirname(path.join(mobileRoot, from)), specifier) : null;
  if (!base) return null;
  const file = ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((ending) => base + ending).find(existsSync);
  return file ? path.relative(mobileRoot, file).replaceAll(path.sep, '/') : null;
}

/** The horizontal scrollers in one file that are not the row, as `file:line <Tag>`, and the files it imports. */
function sweep(name: string, source: string) {
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const plainRows: string[] = [];
  const rows: string[] = [];
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      imports.push(node.moduleSpecifier.text);
    }
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && SCROLLER.test(node.tagName.getText(sourceFile))) {
      const tag = node.tagName.getText(sourceFile);
      const where = `${name}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1} <${tag}>`;
      const horizontal = node.attributes.properties
        .filter(ts.isJsxAttribute)
        .find((attribute) => attribute.name.getText(sourceFile) === 'horizontal');
      const value = horizontal?.initializer && ts.isJsxExpression(horizontal.initializer) ? horizontal.initializer.expression : undefined;
      const sideways = horizontal !== undefined && !(value && unwrap(value).kind === ts.SyntaxKind.FalseKeyword);
      if (tag === 'PagerRowScrollView') rows.push(where);
      else if (sideways) plainRows.push(where);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { plainRows, rows, imports };
}

/** Every file the pages draw from, reached through their imports, with what each sweep found. */
function sweepPages(pages: string[]) {
  const seen = new Map<string, ReturnType<typeof sweep>>();
  const queue = [...pages];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const found = sweep(file, readFileSync(path.join(mobileRoot, file), 'utf8'));
    seen.set(file, found);
    for (const specifier of found.imports) {
      const next = resolveImport(file, specifier);
      if (next && /^(?:app|components)\//.test(next) && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

describe('pager rows — a sideways row on a pager page is a PagerRowScrollView', () => {
  it('sees a plain horizontal scroller', () => {
    const plain = [
      '<ScrollView horizontal keyboardShouldPersistTaps="handled" />',
      '<ScrollView horizontal={true} keyboardShouldPersistTaps="handled" />',
      '<ScrollView horizontal={isRow} keyboardShouldPersistTaps="handled" />',
      '<FlatList horizontal data={pages} renderItem={renderPage} keyboardShouldPersistTaps="handled" />',
      '<Animated.ScrollView horizontal keyboardShouldPersistTaps="handled" />',
      // The four rows before 2026-10-29, in their own words.
      '<ScrollView\n  horizontal\n  keyboardShouldPersistTaps="handled"\n  contentContainerStyle={{ gap: 10 }}\n>\n  {tiles}\n</ScrollView>',
    ];
    for (const source of plain) {
      expect(sweep('case.tsx', `const page = (${source});`).plainRows, source).toHaveLength(1);
    }
  });

  it('passes the row and an upright scroller', () => {
    const fine = [
      '<PagerRowScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10 }} />',
      '<ScrollView keyboardShouldPersistTaps="handled" />',
      '<ScrollView horizontal={false} keyboardShouldPersistTaps="handled" />',
    ];
    for (const source of fine) {
      expect(sweep('case.tsx', `const page = (${source});`).plainRows, source).toEqual([]);
    }
  });

  it('draws every sideways row on the Details page with it', () => {
    const swept = sweepPages(PAGER_PAGES);
    const plainRows = [...swept].filter(([file]) => file !== ROW).flatMap(([, found]) => found.plainRows);
    expect(plainRows).toEqual([]);

    // The sweep reached the rows it was written for, through the imports.
    const rows = [...swept.values()].flatMap((found) => found.rows).map((where) => where.replace(/:\d+ /, ' '));
    expect(rows.sort()).toEqual([
      'components/generation-references.tsx <PagerRowScrollView>',
      'components/generation-references.tsx <PagerRowScrollView>',
      'components/post-resource-bundle-content.tsx <PagerRowScrollView>',
      'components/post-resource-references.tsx <PagerRowScrollView>',
    ]);
    expect(swept.has(ROW)).toBe(true);
  });
});
