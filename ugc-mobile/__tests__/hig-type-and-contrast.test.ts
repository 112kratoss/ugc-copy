import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appTheme } from '../lib/theme';

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

/** Apple's Accessibility guidance: iOS default type is 17pt, minimum 11pt. */
const MIN_TYPE_PT = 11;

describe('HIG type sizes', () => {
  it('keeps every hardcoded type size at or above the iOS minimum', () => {
    const undersized = files.flatMap((filePath) => readFileSync(filePath, 'utf8')
      .split('\n')
      .flatMap((line, index) => {
        const sizes = [...line.matchAll(/(?:fontSize|tabLabelSize):\s*(\d+(?:\.\d+)?)/g)]
          .map((match) => Number(match[1]))
          .filter((size) => size < MIN_TYPE_PT);
        return sizes.map((size) => `${path.relative(mobileRoot, filePath).replaceAll(path.sep, '/')}:${index + 1} (${size}pt)`);
      }));

    expect(undersized).toEqual([]);
  });

  it('keeps the theme type ramp above the minimum', () => {
    const undersized = Object.entries(appTheme.type)
      .filter(([, role]) => (role as { fontSize: number }).fontSize < MIN_TYPE_PT)
      .map(([name]) => name);

    expect(undersized).toEqual([]);
  });
});

/**
 * WCAG AA, the thresholds Accessibility Inspector reports against:
 * 4.5:1 for text up to 17pt, 3:1 for 18pt+ or bold.
 */
function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('HIG colour contrast', () => {
  const backgrounds = [appTheme.colors.background, appTheme.colors.panel, appTheme.colors.panelSoft];
  const foregrounds: Array<[string, string]> = [
    ['text', appTheme.colors.text],
    ['textSecondary', appTheme.colors.textSecondary],
    ['muted', appTheme.colors.muted],
    ['faint', appTheme.colors.faint],
    ['primary', appTheme.colors.primary],
    ['info', appTheme.colors.info],
    ['danger', appTheme.colors.danger],
    ['success', appTheme.colors.success],
    ['warning', appTheme.colors.warning],
  ];

  it('clears 4.5:1 for body text on every panel surface', () => {
    const failures = foregrounds.flatMap(([name, colour]) => backgrounds
      .map((background) => ({ name, background, ratio: contrastRatio(colour, background) }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ background, ratio }) => `${name} on ${background}: ${ratio.toFixed(2)}:1`));

    expect(failures).toEqual([]);
  });
});
