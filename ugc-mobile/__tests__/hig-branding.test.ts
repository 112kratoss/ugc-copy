import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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

const files = ['app', 'components', 'lib'].flatMap((root) => sourceFiles(path.join(mobileRoot, root)));

/**
 * Apple's Branding chapter: "Use your brand's unique voice and tone in all the
 * written communication you display", and the Design principles' Familiarity
 * rule — "Once you establish a behavior or appearance for an element, apply it
 * throughout your design."
 *
 * The app's own name is the first thing that has to obey that. The wordmark on
 * Home, onboarding and the side menu reads Magicbooklet, so every sentence that
 * names the product reads Magicbooklet too. (`app.json`'s `name` stays "Magic
 * Booklet": that string is the App Store listing and the Home Screen label,
 * which change through the store, not through a build.)
 */
const BRAND = 'Magicbooklet';

/**
 * Only the spellings that can only ever be prose. All-lowercase `magicbooklet`
 * is this codebase's slug, URL scheme and tool id — an address rather than the
 * brand — so it is deliberately not listed here.
 */
const OFF_BRAND = [/Magic Booklet/, /MagicBooklet/];

function offBrandSpellings(source: string) {
  return source
    .split('\n')
    .flatMap((line, index) => OFF_BRAND
      .filter((pattern) => pattern.test(line))
      .map((pattern) => `${index + 1}: ${(line.match(pattern) ?? [''])[0].trim()}`));
}

describe('HIG branding — the product has one name', () => {
  it('flags the two-word spelling', () => {
    expect(offBrandSpellings('body="Review how Magic Booklet collects data."')).toEqual(['1: Magic Booklet']);
  });

  it('flags the camel-cased spelling', () => {
    expect(offBrandSpellings('const app = "MagicBooklet";')).toEqual(['1: MagicBooklet']);
  });

  it('leaves the identifiers that are genuinely lowercase alone', () => {
    // Schemes, slugs, hosts and tool ids are addresses, not the brand.
    const identifiers = [
      "const scheme = 'exp+magicbooklet-mobile://';",
      "const site = 'https://magicbooklet.com/invite';",
      "sourceToolSlug: 'magicbooklet',",
    ].join('\n');

    expect(offBrandSpellings(identifiers)).toEqual([]);
  });

  it('spells the product one way everywhere it names itself', () => {
    const violations = files.flatMap((filePath) => offBrandSpellings(readFileSync(filePath, 'utf8'))
      .map((detail) => `${path.relative(mobileRoot, filePath).replaceAll(path.sep, '/')}:${detail}`));

    expect(violations).toEqual([]);
  });

  it('matches the wordmark the app actually renders', () => {
    const welcome = readFileSync(path.join(mobileRoot, 'components/onboarding-welcome.tsx'), 'utf8');

    expect(welcome).toContain(BRAND);
  });
});
