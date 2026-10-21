import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { canBeAbsent, unwrap } from './fixtures/jsx-syntax';

/**
 * A scroll view decides for itself what a tap does while a field's keyboard is
 * up, and its parent's answer does not reach it. React Native 0.83's ScrollView
 * asks every scroller around a new touch, outermost first, in the capture
 * phase (`_handleStartShouldSetResponderCapture` in ScrollView.js): at the
 * default `keyboardShouldPersistTaps` ('never'), with the keyboard up and the
 * touch not on a text input, the scroller takes the touch and spends it on
 * putting the keyboard away, so the control under the finger never hears it.
 * A page that keeps taps ('handled') does not change that for a scroller
 * inside it. On 2026-10-21, on the Pixel_9a, with a multi-shot story's shot
 * prompt focused, the first tap on "8s" closed the keyboard and the shot kept
 * 5s; the shot chips and the search overlay's type tabs did the same. The
 * creator's reference rails were given the prop in A1 (#515).
 *
 * A horizontal scroller is nearly always a row inside a page or a sheet, so
 * every one says what a tap does with the keyboard up. 'handled' is the usual
 * answer: a press on a control in the row answers, and the keyboard stays; a
 * touch on nothing in particular still puts it away. 'never' is for a row that
 * keeps the default on purpose, or for now, with a comment saying why: the post
 * page's pager holds the comment field, and answering taps there is a change of
 * its own (2026-10-21). The FlatList family renders a ScrollView, so it is read
 * too. A spread cannot be read here: one that supplies `horizontal` is not seen,
 * and one written after the prop fails the row, since in JSX the later spread
 * wins.
 */
const SCROLLER = /(?:ScrollView|FlatList|SectionList|FlashList)$/;
const DECISIONS = new Set(['always', 'handled', 'never']);

const mobileRoot = path.resolve(__dirname, '..');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) files.push(...sourceFiles(absolutePath));
    else if (/\.tsx$/.test(entry)) files.push(absolutePath);
  }
  return files;
}

/** `horizontal`, `horizontal={true}` or any expression; only a literal `false` is vertical. */
function isHorizontal(attribute: ts.JsxAttribute | undefined): boolean {
  if (!attribute) return false;
  const value = attribute.initializer;
  return !(value && ts.isJsxExpression(value) && value.expression?.kind === ts.SyntaxKind.FalseKeyword);
}

/**
 * A string the prop takes, or an expression that cannot come out `undefined`, `null` or `false` by
 * its own syntax: React Native reads each of those as the default. The boolean form is out too,
 * written bare or in braces: React Native deprecates it and warns at mount.
 */
function decides(attribute: ts.JsxAttribute | undefined): boolean {
  const value = attribute?.initializer;
  if (!value) return false;
  if (ts.isStringLiteral(value)) return DECISIONS.has(value.text);
  const expression = ts.isJsxExpression(value) ? value.expression : undefined;
  return expression !== undefined && decidesExpression(expression);
}

function decidesExpression(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return DECISIONS.has(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return false;
  // Each arm answers for itself. A value read from elsewhere cannot be read here, so it passes;
  // React Native's own type allows `undefined` and the booleans, so a forwarded prop is not held.
  if (ts.isConditionalExpression(node)) return decidesExpression(node.whenTrue) && decidesExpression(node.whenFalse);
  return !canBeAbsent(node);
}

/** The horizontal scrollers in one file, and those that leave a tap to the default, as `file:line <Tag>`. */
function sweep(name: string, source: string) {
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const horizontal: string[] = [];
  const undecided: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && SCROLLER.test(node.tagName.getText(sourceFile))) {
      const properties = node.attributes.properties;
      const attributes = properties.filter(ts.isJsxAttribute);
      const named = (wanted: string) => attributes.find((attribute) => attribute.name.getText(sourceFile) === wanted);
      if (isHorizontal(named('horizontal'))) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const where = `${name}:${line} <${node.tagName.getText(sourceFile)}>`;
        horizontal.push(where);
        const persists = named('keyboardShouldPersistTaps');
        // In JSX the later spread wins, so one written after the prop can take it back unseen.
        const overridden = persists !== undefined && properties.slice(properties.indexOf(persists) + 1).some(ts.isJsxSpreadAttribute);
        if (!decides(persists) || overridden) undecided.push(where);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { horizontal, undecided };
}

const tree = ['app', 'components', 'lib']
  .flatMap((root) => sourceFiles(path.join(mobileRoot, root)))
  .map((absolutePath) => sweep(path.relative(mobileRoot, absolutePath).replaceAll(path.sep, '/'), readFileSync(absolutePath, 'utf8')));

describe('keyboard taps — a horizontal scroller says what a tap does while the keyboard is up', () => {
  it('sees a horizontal scroller that leaves it to the default', () => {
    const undecided = [
      // The multi-shot story's duration chips on 2026-10-21.
      '<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>{chips}</ScrollView>',
      // Over several lines, past arrows whose `>` a pattern would stop at (the composer's media row).
      '<ScrollView\n  ref={rowRef}\n  horizontal\n  onScroll={(event) => { scrollXRef.current = event.nativeEvent.contentOffset.x; }}\n>\n  {cards}\n</ScrollView>',
      '<Animated.ScrollView horizontal />',
      '<FlatList horizontal data={pages} renderItem={renderPage} />',
      '<FlashList horizontal data={slides} renderItem={renderSlide} />',
      '<ScrollView horizontal={true} />',
      '<ScrollView horizontal={wide} />',
      // What a spread carries cannot be read here, so the prop is written out.
      '<ScrollView {...railProps} horizontal />',
      '<ScrollView horizontal keyboardShouldPersistTaps />',
      '<ScrollView horizontal keyboardShouldPersistTaps={undefined} />',
      '<ScrollView horizontal keyboardShouldPersistTaps="sometimes" />',
      // Expressions that can come out as the default, or as the boolean form.
      "<ScrollView horizontal keyboardShouldPersistTaps={editing ? 'handled' : undefined} />",
      "<ScrollView horizontal keyboardShouldPersistTaps={editing ? 'handled' : 'sometimes'} />",
      "<ScrollView horizontal keyboardShouldPersistTaps={ready && 'handled'} />",
      '<ScrollView horizontal keyboardShouldPersistTaps={rail?.taps} />',
      '<ScrollView horizontal keyboardShouldPersistTaps={void 0} />',
      '<ScrollView horizontal keyboardShouldPersistTaps={(undefined)} />',
      '<ScrollView horizontal keyboardShouldPersistTaps={true} />',
      '<ScrollView horizontal keyboardShouldPersistTaps={false} />',
      // A spread after the prop takes it back.
      '<ScrollView horizontal keyboardShouldPersistTaps="handled" {...rest} />',
      // A page that keeps taps, around a row that does not: the shape of the fault.
      '<ScrollView keyboardShouldPersistTaps="handled">\n  <ScrollView horizontal />\n</ScrollView>',
    ];
    for (const source of undecided) {
      const result = sweep('case.tsx', source);
      expect(result.horizontal, source).toHaveLength(1);
      expect(result.undecided, source).toEqual(result.horizontal);
    }
  });

  it('passes one that decides, and leaves vertical scrollers alone', () => {
    const decided = [
      '<ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} />',
      '<ScrollView {...railProps} horizontal keyboardShouldPersistTaps="handled" />',
      '<FlatList horizontal keyboardShouldPersistTaps="handled" data={pages} renderItem={renderPage} />',
      '<ScrollView horizontal keyboardShouldPersistTaps="never" />',
      "<ScrollView horizontal keyboardShouldPersistTaps={editing ? 'handled' : 'never'} />",
      "<ScrollView horizontal keyboardShouldPersistTaps={'handled'} />",
    ];
    for (const source of decided) expect(sweep('case.tsx', source), source).toEqual({ horizontal: [expect.any(String)], undecided: [] });

    const vertical = [
      '<ScrollView keyboardShouldPersistTaps="handled" />',
      '<ScrollView />',
      '<ScrollView horizontal={false} />',
      '<View horizontal />',
    ];
    for (const source of vertical) expect(sweep('case.tsx', source), source).toEqual({ horizontal: [], undecided: [] });
  });

  it('reads the real tree', () => {
    // A positive control: a sweep that parsed nothing would pass the last test.
    const horizontal = tree.flatMap((file) => file.horizontal);
    expect(horizontal.length).toBeGreaterThanOrEqual(20);
    // The creator's rails and chip rows, and the post composer's rows.
    expect(horizontal.filter((where) => where.startsWith('components/media-creation-screen.tsx:')).length).toBeGreaterThanOrEqual(7);
    expect(horizontal.filter((where) => where.startsWith('app/post/new.tsx:')).length).toBeGreaterThanOrEqual(2);
  });

  it('finds none in app/, components/ or lib/ that leaves it to the default', () => {
    expect(tree.flatMap((file) => file.undecided)).toEqual([]);
  });
});
