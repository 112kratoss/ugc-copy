import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIN_HIT_TARGET_PT } from '../lib/hit-target';
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

/**
 * Apple's UI Design Dos and Don'ts: "Create controls that measure at least
 * 44pt x 44pt", and don't "use controls that are smaller than 44pt x 44pt".
 *
 * Only the opening tag is read, which is what makes this exact rather than a
 * guess: `hitSlop` and `style` are both props, so everything the rule depends
 * on is inside it, and no attempt is made to infer the size of children. The
 * rule it enforces is therefore narrow and deliberate — a tappable element
 * that declares a height *below the minimum* must also declare the slop that
 * brings its hit region back up. It does not try to catch a control that is
 * small for some reason the source never states; that needs Accessibility
 * Inspector against a running build, not a regex.
 */
function openingTags(source: string, tagName: string): Array<{ tag: string; line: number }> {
  const found: Array<{ tag: string; line: number }> = [];
  const pattern = new RegExp(`<${tagName}\\b`, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    // Walk to the `>` that closes this opening tag, ignoring any that sit
    // inside a prop's braces or parens — `style={({ pressed }) => ...}` is full
    // of characters that would otherwise look like the end of the tag.
    let depth = 0;
    let end = -1;
    for (let index = match.index; index < source.length; index += 1) {
      const character = source[index];
      if (character === '{' || character === '(') depth += 1;
      else if (character === '}' || character === ')') depth -= 1;
      else if (character === '>' && depth === 0) { end = index; break; }
    }
    if (end === -1) continue;
    found.push({ tag: source.slice(match.index, end + 1), line: source.slice(0, match.index).split('\n').length });
  }

  return found;
}

function undersizedTapTargets(source: string) {
  return ['Pressable', 'TouchableOpacity'].flatMap((tagName) => openingTags(source, tagName)
    .flatMap(({ tag, line }) => {
      const declared = [...tag.matchAll(/\b(minHeight|height|minWidth|width):\s*(\d+(?:\.\d+)?)/g)]
        // A zero is the flex idiom for "this may shrink below its content",
        // not a declared target size — `minWidth: 0` says there is no minimum
        // rather than that the minimum is tiny.
        .filter((declaration) => Number(declaration[2]) > 0 && Number(declaration[2]) < MIN_HIT_TARGET_PT);

      if (declared.length === 0) return [];
      if (!/hitSlop/.test(tag)) {
        return declared.map((declaration) => `${line}: ${declaration[1]}: ${declaration[2]} with no hitSlop`);
      }

      // Slop written as a bare number, or from any other helper, is taken on
      // trust — this cannot evaluate arbitrary expressions. What it can check
      // is the form this codebase uses, where the argument is meant to be the
      // control's own height: if the two drift apart, the slop silently stops
      // reaching 44pt while still looking correct.
      const computed = tag.match(/hitSlop=\{verticalHitSlop\((\d+)\)\}/);
      if (!computed) return [];

      return declared
        .filter((declaration) => /height/i.test(declaration[1]) && Number(declaration[2]) !== Number(computed[1]))
        .map((declaration) => `${line}: hitSlop computed from ${computed[1]}pt but the control declares ${declaration[2]}pt`);
    }));
}

describe('HIG tap targets', () => {
  it('flags a tappable element that declares a height below the minimum', () => {
    // Proves the scan works, so a green run below means "nothing found" rather
    // than "nothing looked at".
    const offending = `<Pressable onPress={onOpen} style={({ pressed }) => ({ minHeight: 32, opacity: pressed ? 0.8 : 1 })}>`;
    expect(undersizedTapTargets(offending)).toEqual(['1: minHeight: 32 with no hitSlop']);
  });

  it('accepts the same element once it declares the slop that makes up the difference', () => {
    const corrected = `<Pressable onPress={onOpen} hitSlop={verticalHitSlop(32)} style={({ pressed }) => ({ minHeight: 32 })}>`;
    expect(undersizedTapTargets(corrected)).toEqual([]);
  });

  it('leaves the flex-shrink idiom alone, which declares no minimum rather than a small one', () => {
    const flexIdiom = `<Pressable onPress={onOpen} style={{ flex: 1, minWidth: 0 }}>`;
    expect(undersizedTapTargets(flexIdiom)).toEqual([]);
  });

  it('catches slop that has drifted from the height it is meant to make up', () => {
    const drifted = `<Pressable hitSlop={verticalHitSlop(32)} style={{ minHeight: 36 }}>`;
    expect(undersizedTapTargets(drifted)).toEqual(['1: hitSlop computed from 32pt but the control declares 36pt']);
  });

  it('gives every tappable element in the app a hit region of at least 44pt', () => {
    const violations = files.flatMap((filePath) => undersizedTapTargets(readFileSync(filePath, 'utf8'))
      .map((detail) => `${path.relative(mobileRoot, filePath).replaceAll(path.sep, '/')}:${detail}`));

    expect(violations).toEqual([]);
  });
});
