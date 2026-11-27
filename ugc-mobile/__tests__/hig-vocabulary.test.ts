import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '..');

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (root: string) => {
    for (const entry of readdirSync(root)) {
      const absolute = path.join(root, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else if (/\.tsx?$/.test(entry)) files.push(absolute);
    }
  };
  for (const root of ['app', 'components', 'lib']) walk(path.join(mobileRoot, root));
  return files;
}

/**
 * What opens a post or its media: the links of the post page, the reel and the
 * card feed, a card's and a tile's own open, and a tile's zoom source, which
 * every tile open goes through (`zoomSource.capture`).
 */
const MEDIA_OPENERS = new Set([
  'immersivePreviewOpenHref',
  'immersiveViewerHref',
  'onOpen',
  'onOpenPost',
  'openPost',
  'profileMediaFeedHref',
  'showcaseFeedItemOpenHref',
  'textPostViewerHref',
]);

function isHapticCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'haptic';
}

function opensMedia(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    if (name && MEDIA_OPENERS.has(name)) return true;
    if (name === 'capture' && ts.isPropertyAccessExpression(callee) && /zoomSource$/i.test(callee.expression.getText())) return true;
  }
  return ts.forEachChild(node, opensMedia) ?? false;
}

/** The function a call runs in: the handler that plays it. */
function enclosingFunction(node: ts.Node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isArrowFunction(current)
      || ts.isFunctionExpression(current)
      || ts.isFunctionDeclaration(current)
      || ts.isMethodDeclaration(current)
    ) {
      return current;
    }
  }
  return null;
}

describe('app vocabularies (HIG X2, X3)', () => {
  it('routes every haptic through the vocabulary in lib/haptics.ts', () => {
    // Playing haptics: "build clear cause-and-effect relationships"; the
    // vocabulary's semantic names (select/light/soft/medium/success/error) are
    // that relationship, and a direct expo-haptics call is a second dialect
    // waiting to drift.
    const offenders = sourceFiles()
      .filter((file) => !file.endsWith(`lib${path.sep}haptics.ts`))
      .filter((file) => /from 'expo-haptics'/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('plays no haptic where a post or its media opens', () => {
    // Owner, 2026-11-27: "having haptic on opening the media and swiping to
    // other is not needed". Playing haptics: avoid overusing haptics, since one
    // that plays often becomes tiresome. An open is answered by its own motion,
    // the card's press and the zoom, and on the S24 every open buzzed for 110 ms
    // (device feel audit, 2026-11-27). So a handler that opens a post, a
    // tile's media or the reel plays none, whatever else it does.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('haptic.')) continue;
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (isHapticCall(node)) {
          const handler = enclosingFunction(node);
          if (handler?.body && opensMedia(handler.body)) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            offenders.push(`${path.relative(mobileRoot, file)}:${line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(offenders).toEqual([]);
  });

  it('writes ellipses as the typographic character, never three periods', () => {
    // Writing: UI strings use "…" — three periods render as three periods and
    // wrap badly. The regex targets string literals whose visible text ends in
    // "...", not spread syntax or code.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      if (/[A-Za-z]\.\.\.['"`]/.test(source)) {
        offenders.push(path.relative(mobileRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
