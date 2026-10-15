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
 * Actions and state are held the same way: `setAccessibilityActions(null)` and
 * `setViewState(null)` return early, so a view keeps the ones it had. On
 * 2026-10-16 the composer's only media card still offered Move left and Move
 * right, which then reached no handler, and an unlock row still offered Show
 * mature content once it was shown. Inside a state, `busy`, `checked` and
 * `expanded` are written only when they are there, so one that goes back to
 * `undefined` stays too ("busy" kept in the description, Collapse kept as an
 * action), while an absent `selected` or `disabled` clears. A uiautomator dump
 * lists no actions; a dump of each node's action list does
 * (archive/a11y-stale-actions-2026-10-16).
 *
 * So these props get a value in every state: the visible text once it has
 * loaded, or '' to hand the view back to its own text; an empty list of
 * actions; a state object whose `busy`, `checked` and `expanded` are booleans.
 * This sweep fails any JSX attribute of theirs whose expression can, by its own
 * syntax, come out `undefined`, `null` or `false`, and any of those three state
 * keys, or `aria-` state prop, that can come out `undefined` or `null` (`false`
 * is a value there). The hint and the role are left out on purpose: Android's
 * accessibility delegate reads both afresh each time it describes a view, so
 * either can come and go.
 */
const HELD_BY_THE_NATIVE_VIEW = new Set([
  'accessibilityLabel',
  'aria-label',
  'accessibilityValue',
  'aria-valuetext',
  'aria-valuenow',
  'aria-valuemin',
  'aria-valuemax',
  'accessibilityActions',
  'accessibilityState',
]);

/**
 * React Native folds these into `accessibilityState`. A View given none of them
 * (and no state) sends no state at all, and the first three land on held keys.
 */
const STATE_PROPS = new Set(['aria-busy', 'aria-checked', 'aria-expanded', 'aria-selected', 'aria-disabled']);

/** The keys of a state that Android writes only when they are there. */
const HELD_STATE_KEYS = new Set(['busy', 'checked', 'expanded']);

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

function parse(name: string, source: string): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
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
  // `item?.title` is undefined whenever `item` is.
  if (ts.isVoidExpression(node) || ts.isOptionalChain(node)) return true;
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

/** Whether the expression can come out `undefined` or `null` by its own syntax: a state's `false` is a value. */
function canBeNullish(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node) && node.text === 'undefined') return true;
  if (ts.isVoidExpression(node) || ts.isOptionalChain(node)) return true;
  if (ts.isConditionalExpression(node)) return canBeNullish(node.whenTrue) || canBeNullish(node.whenFalse);
  if (ts.isBinaryExpression(node)) {
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return canBeNullish(node.left) || canBeNullish(node.right);
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
        return canBeNullish(node.right);
      default:
        return false;
    }
  }
  return false;
}

/** The held attributes in one file, and those of them that can be absent, as `file:line attribute`. */
function sweep(name: string, source: string) {
  const sourceFile = parse(name, source);
  let seen = 0;
  const absent: string[] = [];
  const report = (node: ts.Node) => absent.push(`${name}:${lineOf(sourceFile, node)} ${node.getText(sourceFile).replace(/\s+/g, ' ')}`);
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node)) {
      const attribute = node.name.getText(sourceFile);
      const value = node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
      if (HELD_BY_THE_NATIVE_VIEW.has(attribute)) {
        seen += 1;
        if (value && canBeAbsent(value)) report(node);
        const state = attribute === 'accessibilityState' && value ? unwrap(value) : undefined;
        if (state && ts.isObjectLiteralExpression(state)) {
          for (const property of state.properties) {
            if (
              ts.isPropertyAssignment(property)
              && HELD_STATE_KEYS.has(property.name.getText(sourceFile))
              && canBeNullish(property.initializer)
            ) report(property);
          }
        }
      } else if (STATE_PROPS.has(attribute)) {
        seen += 1;
        if (value && canBeNullish(value)) report(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { seen, absent };
}

/**
 * The elements in one file that offer accessibility actions, and those of them
 * without an `accessibilityRole` in every state, as `file:line <Tag>`. React
 * Native 0.83's delegate casts the view's role to a non-null type after it has
 * passed an action on (`performAccessibilityAction` in
 * ReactAccessibilityDelegate.kt), so an action on a view with no role kills the
 * app on Android: the probe's own control did on 2026-10-16. `role` does not
 * count, since Android keeps it apart from `accessibilityRole`.
 */
function actionsWithoutRole(name: string, source: string) {
  const sourceFile = parse(name, source);
  let offered = 0;
  const roleless: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const named = (wanted: string) => attributes.find((attribute) => attribute.name.getText(sourceFile) === wanted);
      if (named('accessibilityActions')) {
        offered += 1;
        const role = named('accessibilityRole')?.initializer;
        const always = role !== undefined && (
          ts.isStringLiteral(role)
          || (ts.isJsxExpression(role) && role.expression !== undefined && !canBeAbsent(role.expression))
        );
        if (!always) roleless.push(`${name}:${lineOf(sourceFile, node)} <${node.tagName.getText(sourceFile)}>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { offered, roleless };
}

const tree = ['app', 'components', 'lib']
  .flatMap((root) => sourceFiles(path.join(mobileRoot, root)))
  .map((absolutePath) => {
    const name = path.relative(mobileRoot, absolutePath).replaceAll(path.sep, '/');
    const source = readFileSync(absolutePath, 'utf8');
    return { name, ...sweep(name, source), ...actionsWithoutRole(name, source) };
  });

describe('HIG accessibility — a label, value, action list or state is never set back to undefined', () => {
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
      '<Text accessibilityLabel={item?.title} />',
      // The two action lists fixed on 2026-10-16 (the composer's card, an unlock row).
      "<View accessibilityActions={canDrag ? [\n  { name: 'decrement', label: 'Move left' },\n  { name: 'increment', label: 'Move right' },\n] : undefined} />",
      "<Pressable accessibilityActions={canShowMature ? [{ name: 'showMature', label: 'Show mature content' }] : undefined} />",
      "<View accessibilityActions={open && [{ name: 'dismiss', label: 'Dismiss' }]} />",
      // A state as a whole (the reel's top controls before 2026-10-16), then key by key.
      '<Pressable accessibilityState={selected === undefined ? undefined : { selected }} />',
      '<View accessibilityState={busy ? { busy } : null} />',
      '<View accessibilityState={{ busy: loading ? true : undefined }} />',
      '<View accessibilityState={{ selected, expanded: open ?? undefined }} />',
      "<View accessibilityState={{ checked: partial ? 'mixed' : undefined }} />",
      '<View accessibilityState={{ busy: query?.isFetching }} />',
      '<View aria-expanded={open || undefined} />',
      '<View aria-selected={active ? true : null} />',
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
      '<View accessibilityValue={{ min: 0, max: 100, now: progress?.percent ?? 0 }} />',
      "<View accessibilityActions={canDrag ? [{ name: 'increment', label: 'Move right' }] : []} />",
      "<Pressable accessibilityActions={[{ name: 'dismiss', label: 'Dismiss' }]} />",
      '<Pressable accessibilityState={{ selected }} />',
      '<View accessibilityState={{ busy: loading, expanded: open, disabled }} />',
      '<View accessibilityState={{ ...accessibilityState, disabled }} />',
      // An absent `selected` or `disabled` clears on Android, so those two may come and go.
      '<View accessibilityState={{ selected: active ? true : undefined, disabled: locked || undefined }} />',
      '<View aria-selected={active} />',
      '<View aria-busy={loading && !failed} />',
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

describe('HIG accessibility — a view that offers actions has a role in every state (Android)', () => {
  it('sees an action list on a view that can be without one', () => {
    const roleless = [
      // The probe's control that killed the app on 2026-10-16.
      "<View accessible accessibilityLabel=\"a11y probe control\" accessibilityActions={[{ name: 'next', label: 'Next phase' }]} />",
      "<Pressable role=\"button\" accessibilityActions={[{ name: 'dismiss', label: 'Dismiss' }]} />",
      "<Pressable accessibilityRole={open ? 'button' : undefined} accessibilityActions={[{ name: 'dismiss' }]} />",
      '<View {...rest} accessibilityActions={actions}>\n  <Text>Row</Text>\n</View>',
    ];
    for (const source of roleless) {
      expect(actionsWithoutRole('case.tsx', source), source).toEqual({ offered: 1, roleless: [expect.any(String)] });
    }
  });

  it('passes one whose role is always there', () => {
    const withRole = [
      "<Pressable accessibilityRole=\"button\" accessibilityActions={[{ name: 'dismiss', label: 'Dismiss' }]} />",
      "<View accessibilityRole={canDrag ? 'adjustable' : 'image'} accessibilityActions={canDrag ? [{ name: 'increment' }] : []} />",
      "<Pressable accessibilityRole={'adjustable'} accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} />",
    ];
    for (const source of withRole) expect(actionsWithoutRole('case.tsx', source), source).toEqual({ offered: 1, roleless: [] });
    expect(actionsWithoutRole('case.tsx', '<Pressable accessibilityRole="button" onPress={undo} />')).toEqual({ offered: 0, roleless: [] });
  });

  it('reads the real tree', () => {
    // The composer's card, the unlock row, the undo notice and the audio scrubber.
    expect(tree.reduce((total, file) => total + file.offered, 0)).toBeGreaterThanOrEqual(4);
  });

  it('finds none in app/, components/ or lib/', () => {
    expect(tree.flatMap((file) => file.roleless)).toEqual([]);
  });
});
