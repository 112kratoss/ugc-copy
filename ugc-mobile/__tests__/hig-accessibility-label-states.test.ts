import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * What a screen reader is told has to follow the screen, and on Android it
 * does not when a label or value goes back to `undefined`. React Native 0.83's
 * BaseViewManager writes a view's content description only when it has one to
 * write (`updateViewContentDescription`), so a label that goes from a string to
 * `undefined` is never cleared: on 2026-10-15 the owner's S24 read "Payout
 * balance loading" under a loaded "$8.50" on Your Sales, and the emulator read
 * "Open your creations" on Home's workspace slide after its renders were done.
 * A value that goes back to `undefined` does the opposite: `setAccessibilityValue`
 * clears the whole description, the label with it, which left the composer's
 * only media card without its name. A unit test never sees either, since the
 * prop is right in JS; a uiautomator dump does (`text` against `content-desc`,
 * archive/a11y-stale-label-2026-10-15 in the workspace).
 *
 * So these props get a value in every state: the visible text once it has
 * loaded, or '' to hand the view back to its own text. This sweep fails any
 * JSX attribute of theirs whose expression can, by its own syntax, come out
 * `undefined`, `null` or `false`. The hint and the role are left out on
 * purpose: Android's accessibility delegate reads both afresh each time it
 * describes a view, so either can come and go.
 */
const HELD_BY_THE_NATIVE_VIEW = new Set([
  'accessibilityLabel',
  'aria-label',
  'accessibilityValue',
  'aria-valuetext',
  'aria-valuenow',
  'aria-valuemin',
  'aria-valuemax',
]);

const mobileRoot = path.resolve(__dirname, '..');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) files.push(...sourceFiles(absolutePath));
    else if (/\.tsx?$/.test(entry)) files.push(absolutePath);
  }
  return files;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Whether the expression can come out `undefined`, `null` or `false` by its own syntax. */
function canBeAbsent(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isIdentifier(node) && node.text === 'undefined') return true;
  if (ts.isVoidExpression(node)) return true;
  if (ts.isConditionalExpression(node)) return canBeAbsent(node.whenTrue) || canBeAbsent(node.whenFalse);
  if (ts.isBinaryExpression(node)) {
    switch (node.operatorToken.kind) {
      // `ready && 'Done'` is `false` (or `undefined`, or `0`) whenever it is not 'Done'.
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return true;
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
        return canBeAbsent(node.right);
      default:
        return false;
    }
  }
  return false;
}

/** The held attributes in one file, and those of them that can be absent, as `file:line attribute`. */
function sweep(name: string, source: string) {
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let seen = 0;
  const absent: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && HELD_BY_THE_NATIVE_VIEW.has(node.name.getText(sourceFile))) {
      seen += 1;
      const value = node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
      if (value && canBeAbsent(value)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        absent.push(`${name}:${line} ${node.getText(sourceFile).replace(/\s+/g, ' ')}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { seen, absent };
}

const tree = ['app', 'components', 'lib']
  .flatMap((root) => sourceFiles(path.join(mobileRoot, root)))
  .map((absolutePath) => {
    const name = path.relative(mobileRoot, absolutePath).replaceAll(path.sep, '/');
    return { name, ...sweep(name, readFileSync(absolutePath, 'utf8')) };
  });

describe('HIG accessibility — a label or value is never set back to undefined', () => {
  it('sees every shape that can leave one undefined', () => {
    const absentable = [
      // The two that shipped (Your Sales, Home's workspace slide).
      "<AppText accessibilityLabel={loading ? 'Payout balance loading' : undefined}>{line}</AppText>",
      "<Pressable accessibilityLabel={activeGenerationCount > 0 ? 'Open your creations' : undefined} />",
      // The composer card's value, over two lines.
      "<View accessibilityValue={isDragging\n  ? { text: target }\n  : canDrag ? { text: position } : undefined} />",
      "<Text accessibilityLabel={ready && 'Done'} />",
      '<Text accessibilityLabel={(open ? label : null) as string} />',
      '<Text aria-label={name ?? undefined} />',
      "<Text accessibilityLabel={name || (void 0)} />",
      "<View aria-valuetext={busy ? false : 'Saved'} />",
    ];
    for (const source of absentable) expect(sweep('case.tsx', source), source).toEqual({ seen: 1, absent: [expect.any(String)] });
  });

  it('leaves alone the shapes that always carry a value, and the props Android reads afresh', () => {
    const present = [
      "<AppText accessibilityLabel={loading ? 'Payout balance loading' : line}>{line}</AppText>",
      '<Pressable accessibilityLabel="Create new project" />',
      '<View accessibilityLabel={`${label}, ${index + 1} of ${totalItems}`} />',
      '<View accessibilityLabel={slot.a11yLabel ?? slot.label} />',
      "<View accessibilityLabel={covered ? '' : title} />",
      '<View accessibilityValue={{ text: isDragging ? target : position }} />',
    ];
    for (const source of present) expect(sweep('case.tsx', source), source).toEqual({ seen: 1, absent: [] });

    const readAfresh = [
      "<Pressable accessibilityHint={external ? 'Opens in your browser.' : undefined} />",
      "<Pressable accessibilityRole={open ? 'button' : undefined} />",
    ];
    for (const source of readAfresh) expect(sweep('case.tsx', source), source).toEqual({ seen: 0, absent: [] });
  });

  it('reads the real tree', () => {
    // A positive control: a sweep that parsed nothing would pass the next test.
    expect(tree.map((file) => file.name)).toContain('app/seller-dashboard.tsx');
    expect(tree.length).toBeGreaterThan(250);
    expect(tree.reduce((total, file) => total + file.seen, 0)).toBeGreaterThan(250);
  });

  it('finds none in app/, components/ or lib/', () => {
    expect(tree.flatMap((file) => file.absent)).toEqual([]);
  });
});
