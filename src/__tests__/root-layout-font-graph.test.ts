import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Next preloads a font on every route whose module graph reaches its loader, async chunks included
// (a production build's `.next/server/next-font-manifest.json`). The root layout lazy-loads the welcome
// popup, so nothing it reaches, through a static or a dynamic import, may import the display face or
// the handwriting: until 2026-11-17 the popup did, and /terms, /admin and every other route preloaded
// both files for a page that draws neither.
const SRC = path.resolve(__dirname, '..');
const FORBIDDEN = ['lib/display-font.ts', 'lib/handwriting-font.ts'].map((file) => path.join(SRC, file));

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? path.join(SRC, specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null;
  if (!base) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  return candidates.find((file) => path.extname(file) && existsSync(file)) ?? null;
}

function importers(): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [path.join(SRC, 'app/layout.tsx')];
  seen.set(queue[0], '');
  while (queue.length) {
    const file = queue.pop() as string;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const target = resolveImport(file, match[1]);
      if (target && !seen.has(target)) {
        seen.set(target, file);
        queue.push(target);
      }
    }
  }
  return seen;
}

describe('the root layout and the display faces', () => {
  const graph = importers();

  it('walks the layout and the welcome popup it lazy-loads', () => {
    expect([...graph.keys()].some((file) => file.endsWith('DeferredWelcomeCreditsPopup.tsx'))).toBe(true);
    expect([...graph.keys()].some((file) => file.endsWith('WelcomeCreditsPopup.tsx'))).toBe(true);
  });

  it.each(FORBIDDEN)('never reaches %s', (forbidden) => {
    expect(graph.has(forbidden) ? `imported by ${graph.get(forbidden)}` : null).toBeNull();
  });
});
