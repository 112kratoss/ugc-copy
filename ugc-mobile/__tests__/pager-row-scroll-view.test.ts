import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { canRevealNsfwInApp } from '../lib/nsfw-reveal-policy';
import { SCROLLER, unwrap } from './fixtures/jsx-syntax';

/**
 * A sideways row drawn on a page of a sideways pager is a `PagerRowScrollView`.
 * On Android the pager took every sideways drag that began on a plain scroll
 * view there, so the Details page's references never moved under a finger
 * (Pixel 9a, 2026-10-29); `components/pager-row-scroll-view.tsx` says why its
 * scroll view keeps the drag and `nestedScrollEnabled` did not. No unit test
 * can see who takes a drag, so this one holds the rule in place: the pages
 * below are swept with every component they import, as Metro resolves them for
 * Android, and any other horizontal scroller on them fails. The viewer's own
 * media, text and audio pages are drawn in `app/viewer.tsx` beside its pager
 * and hold no row; the post screen's text (`TextPostContent`) is drawn in
 * `app/post/[id].tsx` beside its pager and holds none either.
 */
const PAGER_PAGES = [
  // The Details page: the viewer's last page, and the post screen's.
  'components/post-details-page.tsx',
  // The post screen's first page: the post and its comments, and a covered post's notice.
  'components/comments-sheet.tsx',
  'components/nsfw-post-notice.tsx',
];

/** The row itself, the one place a plain horizontal scroll view belongs. */
const ROW = 'components/pager-row-scroll-view.tsx';

/** Wrappers whose scroll view takes its direction from the caller's props: their call sites are swept instead. */
const PASS_THROUGH = new Set([
  // The page's own scroll view, which `components/ui.tsx` draws as `ScrollView`.
  'components/media-viewport-scroll-view.tsx',
]);

/** Files the sweep reaches whose horizontal scrollers Android never draws on a pager page, each while its reason holds. */
const ANDROID_NEVER_DRAWS: Record<string, boolean> = {
  // A covered post's own media (`NsfwPostNotice` → this carousel) on the post screen's first page:
  // Android never reveals one yet. The day it can, the carousel is a row on a pager page and fails here.
  'components/showcase-media-preview.tsx': !canRevealNsfwInApp('android'),
};

const mobileRoot = path.resolve(__dirname, '..');

/** The file Metro bundles for Android: a platform file before the plain one, a file before a folder's index. */
function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(mobileRoot, specifier.slice(2))
    : specifier.startsWith('.') ? path.resolve(path.dirname(path.join(mobileRoot, from)), specifier) : null;
  if (!base) return null;
  const candidates = [base, path.join(base, 'index')].flatMap((stem) => ['ts', 'tsx'].flatMap((extension) =>
    ['.android', '.native', ''].map((platform) => `${stem}${platform}.${extension}`)));
  const file = candidates.find(existsSync);
  return file ? path.relative(mobileRoot, file).replaceAll(path.sep, '/') : null;
}

/**
 * Whether a `selectable` prop leaves the words unselectable on Android: absent, `false`, or iOS only.
 * Inside a row a selectable word is a touch target of its own, and gesture handler's root takes the
 * rest of a drag without cancelling it: a flick that began on a tile's title selected a word ~0.4 s
 * later (Pixel 9a, 2026-10-29). iOS cancels it as the scroll begins.
 */
function selectableOffOnAndroid(attribute: ts.JsxAttribute | undefined, sourceFile: ts.SourceFile) {
  if (!attribute) return true;
  const value = attribute.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
  if (!value) return false;
  const expression = unwrap(value);
  return expression.kind === ts.SyntaxKind.FalseKeyword || expression.getText(sourceFile).replace(/\s+/g, ' ') === "Platform.OS === 'ios'";
}

/**
 * The horizontal scrollers in one file that are not the row, and the words inside a row that Android
 * would let a reader select, each as `file:line <Tag>`, with the files it imports.
 */
function sweep(name: string, source: string) {
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const plainRows: string[] = [];
  const selectableInRows: string[] = [];
  const imports: string[] = [];
  const where = (node: ts.JsxOpeningLikeElement) =>
    `${name}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1} <${node.tagName.getText(sourceFile)}>`;
  const visit = (node: ts.Node, inRow: boolean) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      imports.push(node.moduleSpecifier.text);
    }
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && SCROLLER.test(node.tagName.getText(sourceFile))) {
      const tag = node.tagName.getText(sourceFile);
      // The last word on `horizontal` decides; a spread may carry it, so only a `horizontal={false}`
      // written after every spread says the scroller is upright.
      let sideways = false;
      for (const property of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(property)) {
          sideways = true;
        } else if (property.name.getText(sourceFile) === 'horizontal') {
          const value = property.initializer && ts.isJsxExpression(property.initializer) ? property.initializer.expression : undefined;
          sideways = !(value && unwrap(value).kind === ts.SyntaxKind.FalseKeyword);
        }
      }
      if (tag !== 'PagerRowScrollView' && sideways) plainRows.push(where(node));
    }
    if (inRow && (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && /(?:^|\.)[A-Za-z]*Text$/.test(node.tagName.getText(sourceFile))) {
      const selectable = node.attributes.properties
        .filter(ts.isJsxAttribute)
        .find((attribute) => attribute.name.getText(sourceFile) === 'selectable');
      if (!selectableOffOnAndroid(selectable, sourceFile)) selectableInRows.push(where(node));
    }
    const row = ts.isJsxElement(node) && node.openingElement.tagName.getText(sourceFile) === 'PagerRowScrollView';
    ts.forEachChild(node, (child) => visit(child, inRow || row));
  };
  visit(sourceFile, false);
  return { plainRows, selectableInRows, imports };
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
      if (next && /^(?:app|components|lib)\//.test(next) && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

describe('pager rows — a sideways row on a pager page is a PagerRowScrollView', () => {
  it('sees a plain horizontal scroller', () => {
    const plain = [
      '<ScrollView horizontal keyboardShouldPersistTaps="handled" />',
      '<ScrollView horizontal={isRow} keyboardShouldPersistTaps="handled" />',
      '<FlatList horizontal data={pages} renderItem={renderPage} keyboardShouldPersistTaps="handled" />',
      '<Animated.ScrollView horizontal keyboardShouldPersistTaps="handled" />',
      // A spread may carry `horizontal`, and one after it takes back what was written.
      '<ScrollView {...rowProps} keyboardShouldPersistTaps="handled" />',
      '<ScrollView horizontal={false} {...rowProps} keyboardShouldPersistTaps="handled" />',
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
      '<ScrollView {...pageProps} horizontal={false} keyboardShouldPersistTaps="handled" />',
    ];
    for (const source of fine) {
      expect(sweep('case.tsx', `const page = (${source});`).plainRows, source).toEqual([]);
    }
  });

  it('sees a word inside a row that Android would select', () => {
    const selectable = [
      '<PagerRowScrollView keyboardShouldPersistTaps="handled"><Text selectable>@ali</Text></PagerRowScrollView>',
      '<PagerRowScrollView keyboardShouldPersistTaps="handled">{items.map((item) => <Pressable key={item.id}><Text selectable={true}>{item.title}</Text></Pressable>)}</PagerRowScrollView>',
      '<PagerRowScrollView keyboardShouldPersistTaps="handled"><AppText selectable={copyable}>@ali</AppText></PagerRowScrollView>',
    ];
    for (const source of selectable) {
      expect(sweep('case.tsx', `const page = (${source});`).selectableInRows, source).toHaveLength(1);
    }
    const fine = [
      '<PagerRowScrollView keyboardShouldPersistTaps="handled"><Text>@ali</Text></PagerRowScrollView>',
      "<PagerRowScrollView keyboardShouldPersistTaps=\"handled\"><Text selectable={Platform.OS === 'ios'}>@ali</Text></PagerRowScrollView>",
      '<PagerRowScrollView keyboardShouldPersistTaps="handled"><Text selectable={false}>@ali</Text></PagerRowScrollView>',
      // Outside a row a word may be selectable: nothing takes the drag from under it.
      '<View><Text selectable>The prompt</Text><PagerRowScrollView keyboardShouldPersistTaps="handled" /></View>',
    ];
    for (const source of fine) {
      expect(sweep('case.tsx', `const page = (${source});`).selectableInRows, source).toEqual([]);
    }
  });

  it('resolves an import to the file Android bundles', () => {
    // The Details page's menu: Android draws `native-menu.android.tsx`, not the plain file tests load.
    expect(resolveImport('components/viewer-actions-menu.tsx', '@/components/native-menu')).toBe('components/native-menu.android.tsx');
    expect(resolveImport('components/post-details-page.tsx', './pager-row-scroll-view')).toBe(ROW);
  });

  it('draws every sideways row on a pager page with it', () => {
    const swept = sweepPages(PAGER_PAGES);
    const plainRows = [...swept]
      .filter(([file]) => file !== ROW && !PASS_THROUGH.has(file) && !ANDROID_NEVER_DRAWS[file])
      .flatMap(([, found]) => found.plainRows);
    expect(plainRows).toEqual([]);
    expect([...swept.values()].flatMap((found) => found.selectableInRows)).toEqual([]);

    // The sweep reached the rows it was written for, and Android's own files, through the imports.
    expect([...swept.keys()]).toEqual(expect.arrayContaining([
      ROW,
      'components/generation-references.tsx',
      'components/post-resource-bundle-content.tsx',
      'components/post-resource-references.tsx',
      'components/native-menu.android.tsx',
      'components/showcase-media-preview.tsx',
    ]));
  });
});
