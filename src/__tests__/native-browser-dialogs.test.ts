import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The browser's own alert, confirm and prompt: unstyled, titled with the
// site's address rather than the app, and blocking the whole page. A question
// goes through `requestConfirmation` (`useConfirmation` in a component), which
// draws the app's dialog. Its answer for a render with no viewport mounted,
// a test rendering one component, is the one native call left.
const NATIVE_DIALOGS = new Set(['alert', 'confirm', 'prompt']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

const projectRoot = process.cwd();

function listSourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const fullPath = join(root, entry);
    if (statSync(fullPath).isDirectory()) {
      return entry === '__tests__' ? [] : listSourceFiles(fullPath);
    }
    return /\.tsx?$/.test(entry) ? [fullPath] : [];
  });
}

/**
 * Each call of a native dialog in the source, as its name: `confirm(…)`,
 * `window.confirm(…)` and the like, never a method of another object. A local
 * function named `confirm` counts too; name it something else.
 */
function findNativeDialogCalls(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          && ts.isIdentifier(callee.expression)
          && GLOBAL_OBJECTS.has(callee.expression.text)
          ? callee.name.text
          : null;
      if (name && NATIVE_DIALOGS.has(name)) calls.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

describe('native browser dialogs', () => {
  it('are found as calls, and not as words or other objects’ methods', () => {
    const source = [
      "// Ask with confirm() first, or prompt (it reads) the user.",
      "window.confirm('a');",
      "confirm('b');",
      "globalThis.alert('c');",
      "const answer = <p onClick={() => window.prompt('d')}>prompt (e)</p>;",
      "payment.confirm('f');",
      "askToConfirm('g');",
      "const label = 'confirm(h)';",
    ].join('\n');

    expect(findNativeDialogCalls('probe.tsx', source)).toEqual(['confirm', 'confirm', 'alert', 'prompt']);
  });

  it('are opened nowhere in the app but in the confirmation fallback', () => {
    const found = listSourceFiles(join(projectRoot, 'src')).flatMap((filePath) => (
      findNativeDialogCalls(filePath, readFileSync(filePath, 'utf8'))
        .map((name) => `${relative(projectRoot, filePath)} ${name}`)
    ));

    expect(found).toEqual(['src/components/feedback-state.ts confirm']);
  });
});
