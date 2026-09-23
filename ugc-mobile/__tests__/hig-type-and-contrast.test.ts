import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// `tab-bar-ambient` reads `Platform.OS` to skip work on the platform whose dock
// never adapts, and vitest cannot parse react-native's own entry point. The
// colours this file asserts are platform-independent.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { contrastRatio } from '../lib/color-contrast';
import { MIN_HIT_TARGET_PT } from '../lib/hit-target';
import { appTheme, themes, type ColorScheme } from '../lib/theme';
import {
  ADAPTIVE_INACTIVE_COLOR,
  ADAPTIVE_INACTIVE_LIGHT_COLOR,
  DEFAULT_LIGHT_TAB_BAR_COLOR,
  DEFAULT_TAB_BAR_COLOR,
  getTabBarFillFromThumbhash,
} from '../lib/tab-bar-ambient';

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

/**
 * The display face (`DISPLAY_FONT`) is registered as two single-weight families,
 * so every `appTheme.type` variant that uses it pins `fontWeight: '400'`. A call
 * site that overrides that weight does not get a heavier version of the face —
 * captured on device in S13: iOS ignores the incompatible weight and keeps
 * Bricolage, while **Android loses the family and falls back to the system
 * sans**, so the same screen ships in two different typefaces.
 *
 * `components/profile-dashboard.tsx` was the only file in the tree doing it, and
 * the screen it did it on was the profile tab's own page title.
 */
const DISPLAY_VARIANTS = Object.entries(appTheme.type)
  .filter(([, value]) => 'fontFamily' in value)
  .map(([name]) => name);

describe('the display face keeps its own weight', () => {
  it('names the variants that carry it', () => {
    expect(DISPLAY_VARIANTS.length).toBeGreaterThan(0);
    for (const name of DISPLAY_VARIANTS) {
      expect(
        appTheme.type[name as keyof typeof appTheme.type],
        `${name} must pin fontWeight so Android keeps the family`
      ).toMatchObject({ fontWeight: '400' });
    }
  });

  it('is never re-weighted at a call site', () => {
    const offenders = files.flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      const hits: string[] = [];

      for (const variant of DISPLAY_VARIANTS) {
        // One JSX element at a time: from `variant="pageTitle"` to the `>` that
        // closes its opening tag, so a `fontWeight` on the *next* element does
        // not get attributed to this one.
        const pattern = new RegExp(`variant="${variant}"`, 'g');
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(source))) {
          let depth = 0;
          let end = -1;
          for (let index = match.index; index < source.length; index += 1) {
            const character = source[index];
            if (character === '{' || character === '(') depth += 1;
            else if (character === '}' || character === ')') depth -= 1;
            else if (character === '>' && depth === 0) { end = index; break; }
          }
          if (end === -1) continue;
          if (/fontWeight/.test(source.slice(match.index, end + 1))) {
            hits.push(`${path.relative(mobileRoot, filePath)} (${variant})`);
          }
        }
      }

      return hits;
    });

    expect(offenders).toEqual([]);
  });
});


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

/** Real thumbhashes spanning warm, cool, vivid, near-black and near-white media. */
const MEDIA_FIXTURES = [
  '1xcCXxB4eHd/h3iGh1iHmIiIhgiYiIAJ',
  'lzgCXxB4d3dwiIiJeKiIaIiHifhoiI8G',
  'TLgBBwCIeHiIeHhweIeHeId6iHQHd5gP',
  '3ScDBwA6WnZ5h3h4d4h4d4h2cH+HeKAF',
  'GwgCBwB7XId4iId4h3eIh4iHAAAAAAAA',
  'xAcCBwCIaHd3eHd4eHh3h4hwB2mHAAAA',
  '+gcCBwB4eId4h4eHdwd4d4dwi19oAAAA',
];

/**
 * Both palettes are held to the same floor. The light one could not simply
 * invert the dark one: the dark palette's pastels were picked to glow on black
 * and fail on paper (coral is 2.4:1 there), so every foreground below has its
 * own light value, and the sweep runs once per scheme so neither can drift.
 */
describe.each(['dark', 'light'] as ColorScheme[])('HIG colour contrast (%s)', (scheme) => {
  const colors = themes[scheme].colors;
  const backgrounds = [colors.background, colors.panel, colors.panelSoft, colors.surfaceInset];
  const foregrounds: Array<[string, string]> = [
    ['text', colors.text],
    ['textSecondary', colors.textSecondary],
    ['muted', colors.muted],
    ['faint', colors.faint],
    ['primary', colors.primary],
    ['primaryStrong', colors.primaryStrong],
    ['info', colors.info],
    ['danger', colors.danger],
    ['success', colors.success],
    ['warning', colors.warning],
    ['image', colors.image],
    ['video', colors.video],
    ['motion', colors.motion],
    ['workflow', colors.workflow],
    ['amber', colors.amber],
    ['commerce', colors.commerce],
  ];

  it('keeps selected navigation labels readable throughout the capsule transition', () => {
    for (const foreground of [colors.primary, colors.muted]) {
      expect(contrastRatio(foreground, colors.navigationSelected)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps ink on a coral fill, and coral text on a selected surface, legible', () => {
    expect(contrastRatio(colors.onPrimary, colors.primaryFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.primary, colors.selected)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.textInverse, colors.surfaceInverse)).toBeGreaterThanOrEqual(4.5);
  });

  it('clears 4.5:1 for body text on every panel surface', () => {
    const failures = foregrounds.flatMap(([name, colour]) => backgrounds
      .map((background) => ({ name, background, ratio: contrastRatio(colour, background) }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ background, ratio }) => `${name} on ${background}: ${ratio.toFixed(2)}:1`));

    expect(failures).toEqual([]);
  });
});

describe('HIG colour contrast (derived surfaces)', () => {
  /**
   * The surfaces above are static, which is the whole reason the adaptive tab
   * bar slipped past this file: its fill is computed at runtime from whatever
   * media a creator uploaded, so no palette entry ever described it. Every fill
   * it emitted from its category palette failed here — coral at 2.44:1 on the
   * amber dock — while this suite stayed green.
   *
   * A surface whose colour is derived rather than declared has to be swept over
   * its inputs, not looked up. `tab-bar-ambient.test.ts` sweeps the input space
   * in depth; this is the entry that keeps the dock inside the HIG contract the
   * rest of the app is held to, so a later derived surface is added beside it
   * rather than being left to invent its own floor.
   */
  it('clears 4.5:1 on the tab-bar fill, which is derived rather than declared', () => {
    const tabForegrounds: Array<[string, string]> = [
      ['active tab (primary)', themes.dark.colors.primary],
      ['inactive tab label', ADAPTIVE_INACTIVE_COLOR],
    ];
    const fills = [DEFAULT_TAB_BAR_COLOR, ...MEDIA_FIXTURES.map((hash) => getTabBarFillFromThumbhash(hash))];

    const failures = tabForegrounds.flatMap(([name, colour]) => fills
      .map((fill) => ({ name, fill, ratio: contrastRatio(colour, fill) }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ fill, ratio }) => `${name} on ${fill}: ${ratio.toFixed(2)}:1`));

    expect(failures).toEqual([]);
  });

  it('clears 4.5:1 on the light tab-bar fill, for the deep coral and the ink label', () => {
    const tabForegrounds: Array<[string, string]> = [
      ['active tab (light primary)', themes.light.colors.primary],
      ['inactive tab label (light)', ADAPTIVE_INACTIVE_LIGHT_COLOR],
    ];
    const fills = [DEFAULT_LIGHT_TAB_BAR_COLOR, ...MEDIA_FIXTURES.map((hash) => getTabBarFillFromThumbhash(hash, 'light'))];

    const failures = tabForegrounds.flatMap(([name, colour]) => fills
      .map((fill) => ({ name, fill, ratio: contrastRatio(colour, fill) }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ fill, ratio }) => `${name} on ${fill}: ${ratio.toFixed(2)}:1`));

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
