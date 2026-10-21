import ts from 'typescript';

/**
 * What a JSX attribute's expression can come out as, read from its own syntax.
 * Shared by the guard tests that sweep the tree with the TypeScript parser
 * (`hig-accessibility-label-states.test.ts`, `keyboard-taps-coverage.test.ts`):
 * a prop a native view holds, or a scroll view reads at a touch, has to be
 * given a value in every state, and these say whether the expression written
 * for it can fail to be one. Vitest collects only `*.test.ts(x)` under
 * `__tests__/`, so this module runs no tests of its own.
 */

/** The expression under its parentheses, `as`, `satisfies` and `!`. */
export function unwrap(expression: ts.Expression): ts.Expression {
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
export function canBeAbsent(expression: ts.Expression): boolean {
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
export function canBeNullish(expression: ts.Expression): boolean {
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
