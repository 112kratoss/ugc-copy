import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The production build must not reach Google: a failed `next/font/google` fetch broke CI's build several
// times (2026-11-17 and before). The faces are committed under src/fonts/ and loaded with next/font/local.
const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.(tsx?|css)$/.test(name) ? [full] : [];
  });
}

describe('fonts at build time', () => {
  it('imports no font from next/font/google', () => {
    const offenders = sourceFiles(SRC).filter((file) => /from\s+['"]next\/font\/google['"]|@import\s+url\(['"]?https:\/\/fonts\.googleapis\.com/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it.each(['display-font.ts', 'handwriting-font.ts', 'geist-font.ts'])('%s names only files that are committed', (module) => {
    const source = readFileSync(path.join(SRC, 'lib', module), 'utf8');
    const paths = [...source.matchAll(/path:\s*'(\.\.\/fonts\/[^']+)'/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const rel of paths) {
      const bytes = readFileSync(path.resolve(SRC, 'lib', rel));
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
  });

  // next/font/local names the class's and the variable's family after the exported const whatever a
  // `font-family` declaration says, so every subset face must declare that name or its text falls back.
  it.each([['display-font.ts', 'displayFont'], ['handwriting-font.ts', 'handwritingFont'], ['geist-font.ts', 'geistSans']])('%s: subset faces share the family of the exported %s', (module, primary) => {
    const source = readFileSync(path.join(SRC, 'lib', module), 'utf8');
    expect(source).toMatch(new RegExp(`export const ${primary} = localFont\\(`));
    const declared = [...source.matchAll(/prop: 'font-family', value: '([^']+)'/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(declared)).toEqual(new Set([primary]));
  });
});
