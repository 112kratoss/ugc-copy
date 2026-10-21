import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
 * touch on nothing in particular still puts it away. 'never' is for a row where
 * spending the first tap on the keyboard is the point, with a comment saying
 * why. The FlatList family renders a ScrollView, so it is read too.
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

/** A string the prop takes, or an expression that cannot be `undefined` or `null` by its own syntax. */
function decides(attribute: ts.JsxAttribute | undefined): boolean {
  const value = attribute?.initializer;
  // Absent, or bare: the boolean form, which React Native deprecates and warns about.
  if (!value) return false;
  if (ts.isStringLiteral(value)) return DECISIONS.has(value.text);
  const expression = ts.isJsxExpression(value) ? value.expression : undefined;
  if (!expression) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return false;
  return !(ts.isIdentifier(expression) && expression.text === 'undefined');
}

/** The horizontal scrollers in one file, and those that leave a tap to the default, as `file:line <Tag>`. */
function sweep(name: string, source: string) {
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const horizontal: string[] = [];
  const undecided: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && SCROLLER.test(node.tagName.getText(sourceFile))) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const named = (wanted: string) => attributes.find((attribute) => attribute.name.getText(sourceFile) === wanted);
      if (isHorizontal(named('horizontal'))) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const where = `${name}:${line} <${node.tagName.getText(sourceFile)}>`;
        horizontal.push(where);
        if (!decides(named('keyboardShouldPersistTaps'))) undecided.push(where);
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
    ];
    for (const source of undecided) {
      expect(sweep('case.tsx', source), source).toEqual({ horizontal: ['case.tsx:1 ' + source.match(/<[\w.]+/)![0] + '>'], undecided: [expect.any(String)] });
    }
  });

  it('passes one that decides, and leaves vertical scrollers alone', () => {
    const decided = [
      '<ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} />',
      '<ScrollView {...railProps} horizontal keyboardShouldPersistTaps="handled" />',
      '<FlatList horizontal keyboardShouldPersistTaps="handled" data={pages} renderItem={renderPage} />',
      '<ScrollView horizontal keyboardShouldPersistTaps="never" />',
      "<ScrollView horizontal keyboardShouldPersistTaps={editing ? 'handled' : 'never'} />",
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
    // The creator's rails and chip rows, and the post composer's two rows.
    expect(horizontal.filter((where) => where.startsWith('components/media-creation-screen.tsx:')).length).toBeGreaterThanOrEqual(7);
    expect(horizontal.filter((where) => where.startsWith('app/post/new.tsx:')).length).toBe(2);
  });

  it('finds none in app/, components/ or lib/ that leaves it to the default', () => {
    expect(tree.flatMap((file) => file.undecided)).toEqual([]);
  });
});
