// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * A route that links `non-public-utilities.css` loads it after `globals.css`,
 * and it stays in the document after a client navigation to any other page,
 * public ones included: React keeps a stylesheet it has inserted. Both sheets
 * put their utilities in the same cascade layer, so between two rules of the
 * same weight the later sheet wins, whatever order Tailwind gave the two
 * utilities. While the supplement held some of globals.css's utilities and not
 * others, its copy of a base utility beat a breakpoint or hover rule that only
 * globals.css held: the reel's `h-8` over `lg:h-px` on the profile, and the
 * blog's title at 36px for 48px after a client navigation from a signed-in
 * route, until a reload.
 *
 * So the supplement must hold every utility rule of globals.css, compiled the
 * same way (a breakpoint or theme token that differs between the two sheets'
 * `@theme` blocks would put its copy in another media query) and in the same
 * order. Then its own order, which is Tailwind's, decides on every page.
 */

const APP_ROOT = path.join(process.cwd(), 'src', 'app');

// What the supplement may weigh, unminified, before someone looks again: it held
// 304,138 bytes on 2026-10-19 (227,660 minified), and every full load of a route
// that links it inlines it twice, in its <style> and in the RSC payload.
const SUPPLEMENT_BYTES_CEILING = 335_000;

type CompiledSheet = {
  bytes: number;
  // Each top-level rule of the utilities layer, by selector, as it compiled.
  rules: { selector: string; text: string }[];
};

/**
 * `var(--x, fallback)` reads as `var(--x)`: the supplement references the
 * theme (`@theme reference`), so Tailwind writes each variable with its value
 * as a fallback, where globals.css, which defines it, writes it bare.
 */
function withoutVariableFallbacks(css: string): string {
  let result = '';
  let index = 0;
  while (index < css.length) {
    const start = css.indexOf('var(--', index);
    if (start === -1) return result + css.slice(index);
    result += css.slice(index, start);
    let depth = 0;
    let comma = -1;
    let end = start + 'var('.length - 1;
    for (; end < css.length; end += 1) {
      if (css[end] === '(') depth += 1;
      if (css[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      if (css[end] === ',' && depth === 1 && comma === -1) comma = end;
    }
    result += comma === -1 ? css.slice(start, end + 1) : `${css.slice(start, comma)})`;
    index = end + 1;
  }
  return result;
}

async function compileSheet(stylesheet: string): Promise<CompiledSheet> {
  const result = await postcss([tailwind({ optimize: false })])
    .process(readFileSync(stylesheet, 'utf8'), { from: stylesheet });
  const rules: CompiledSheet['rules'] = [];

  postcss.parse(result.css).walkAtRules('layer', (layer) => {
    if (layer.params !== 'utilities') return;
    for (const node of layer.nodes ?? []) {
      if (node.type !== 'rule') continue;
      rules.push({ selector: node.selector, text: withoutVariableFallbacks(node.toString().replace(/\s+/g, ' ')) });
    }
  });

  return { bytes: Buffer.byteLength(result.css), rules };
}

describe('the two stylesheets of a page drawn with both', () => {
  let publicSheet: CompiledSheet;
  let supplement: CompiledSheet;

  beforeAll(async () => {
    publicSheet = await compileSheet(path.join(APP_ROOT, 'globals.css'));
    supplement = await compileSheet(path.join(APP_ROOT, 'non-public-utilities.css'));
  }, 120_000);

  it('holds every utility rule of globals.css in the supplement, compiled the same way and in the same order', () => {
    // The reading has to be of real sheets: both hold the plain utilities every page uses.
    expect(publicSheet.rules.some(({ selector }) => selector === '.lg\\:h-px')).toBe(true);
    expect(supplement.rules.some(({ selector }) => selector === '.h-8')).toBe(true);
    expect(publicSheet.rules.length).toBeGreaterThan(500);

    const supplementRules = new Map<string, { text: string; position: number }[]>();
    supplement.rules.forEach(({ selector, text }, position) => {
      supplementRules.set(selector, [...(supplementRules.get(selector) ?? []), { text, position }]);
    });

    const missing: string[] = [];
    const different: string[] = [];
    const outOfOrder: string[] = [];
    let lastPosition = -1;
    let lastSelector = '';
    for (const { selector, text } of publicSheet.rules) {
      const copies = supplementRules.get(selector);
      if (!copies) {
        missing.push(selector);
        continue;
      }
      const copy = copies.find((candidate) => candidate.text === text && candidate.position > lastPosition)
        ?? copies.find((candidate) => candidate.text === text);
      if (!copy) {
        different.push(`${text}  !=  ${copies.map((candidate) => candidate.text).join(' | ')}`);
        continue;
      }
      if (copy.position < lastPosition) outOfOrder.push(`${selector} comes before ${lastSelector} in the supplement`);
      lastPosition = copy.position;
      lastSelector = selector;
    }

    expect(missing, 'utilities of globals.css the supplement does not hold').toEqual([]);
    expect(different, 'utilities the two sheets compile differently').toEqual([]);
    expect(outOfOrder, 'utilities the supplement orders differently').toEqual([]);
  });

  it('keeps the supplement under its size ceiling', () => {
    expect(supplement.bytes).toBeLessThan(SUPPLEMENT_BYTES_CEILING);
  });
});
