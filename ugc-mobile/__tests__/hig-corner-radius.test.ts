import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appTheme } from '../lib/theme';

// Every corner in the app is one of three shapes, as Apple's are (docs/design/design-mobile.md →
// Radius; SwiftUI's `Capsule`, `RoundedRectangle` and iOS 26's `ConcentricRectangle`):
// - a capsule: anything pressed on one row, and every circle (`appTheme.radii.pill`, or a size / 2);
// - a fixed step from `appTheme.radii` for the outermost container, by its size;
// - a concentric radius for a shape nested close inside a rounded container: the container's
//   radius less the gap between their edges, written from the tokens (`MENU_RADIUS - MENU_PADDING`).
// Until November 2026 the app drew 36 different radii (14, 17, 21, 15.5…), 263 of them as bare
// numbers, so two controls of one kind rarely matched, on a screen or across screens.
//
// So a radius is written with no number in it but 0 and the `/ 2` of a circle, and every rounded
// rectangle draws iOS's continuous corner (`borderCurve: 'continuous'`, which Android ignores).
// Capsules and circles keep their round ends. A constant named for a radius is held to the same rule.
const root = path.join(__dirname, '..');
const scanned = ['app', 'components', 'lib'];

const RADIUS_DECLARATION = /\bborder(?:TopLeft|TopRight|BottomLeft|BottomRight|TopStart|TopEnd|BottomStart|BottomEnd)?Radius\s*:\s*([^,}\n]+)/g;
const RADIUS_CONSTANT = /\bconst\s+([A-Z][A-Z0-9_]*RADIUS)\s*=\s*([^;\n]+)/g;
// A corner handed to a component that draws it (`MediaPreview`, `SkeletonBone`, a zoom source,
// Explore's tile layout); a shadow's blur radius is not a corner.
const RADIUS_PROP = /\b(?:radius|mediaRadius)(?:=\{|\s*:\s*)([^,}\n)]+)/g;
// Findings that are the point, each counted so a new one beside them still fails.
const EXEMPT: Array<{ file: string; text: string; count: number; why: string }> = [
  {
    file: 'components/media-creation-screen.tsx',
    text: 'radius 2: 2 is off the token scale',
    count: 1,
    why: 'the aspect-ratio mark beside a ratio option: a drawing of the ratio at a few points across, not a surface',
  },
  {
    file: 'components/media-zoom.tsx',
    text: "radius frame.value.radius without borderCurve: 'continuous'",
    count: 2,
    why: "the zoom flight's animated clip, which runs on Android only (iOS opens the reel with UIKit's zoom), where no continuous corner exists",
  },
  {
    file: 'components/media-preview.tsx',
    text: "radius radius without borderCurve: 'continuous'",
    count: 1,
    why: "the picture's own style: an image takes no borderCurve (React Native's ImageStyle has none)",
  },
  {
    file: 'components/remix-source-row.tsx',
    text: "radius POSTER_RADIUS without borderCurve: 'continuous'",
    count: 1,
    why: "the poster's own style: an image takes no borderCurve (React Native's ImageStyle has none)",
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Comments out, keeping every line where it was, so a finding names the right line. */
function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (match, before: string) => before + ' '.repeat(match.length - before.length));
}

/** A number written in a radius, other than 0 and the `/ 2` that makes a circle of a size. */
export function radiusLiteral(value: string): string | null {
  const stripped = value.replace(/\/\s*2\b/g, '').replace(/\b(?:appTheme|theme)\.radii\.\w+/g, '');
  const literal = stripped.match(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])/g)?.find((number) => Number(number) !== 0);
  return literal ?? null;
}

/** Capsules and circles keep round ends; everything else is a rounded rectangle. */
function isCapsule(value: string) {
  return /\bradii\.pill\b/.test(value) || /\/\s*2\s*$/.test(value.trim());
}

/** The style object a declaration sits in: from its `{` to the matching `}`. */
function enclosingObject(source: string, index: number) {
  let depth = 0;
  let start = index;
  for (; start >= 0; start -= 1) {
    const char = source[start];
    if (char === '}') depth += 1;
    if (char === '{') {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  depth = 0;
  let end = index;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === '{') depth += 1;
    if (char === '}') {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  return source.slice(Math.max(0, start), end + 1);
}

type Finding = { file: string; line: number; problem: string };

function scan(): { files: string[]; findings: Finding[] } {
  const files: string[] = [];
  const findings: Finding[] = [];
  for (const dir of scanned) {
    for (const full of sourceFiles(path.join(root, dir))) {
      const file = path.relative(root, full);
      files.push(file);
      const source = withoutComments(readFileSync(full, 'utf8'));
      const lineOf = (index: number) => source.slice(0, index).split('\n').length;
      for (const match of source.matchAll(RADIUS_DECLARATION)) {
        const value = match[1].trim();
        const literal = radiusLiteral(value);
        if (literal) {
          findings.push({ file, line: lineOf(match.index), problem: `radius ${value}: ${literal} is off the token scale` });
          continue;
        }
        if (value === '0' || isCapsule(value)) continue;
        if (!/borderCurve\s*:\s*['"]continuous['"]/.test(enclosingObject(source, match.index))) {
          findings.push({ file, line: lineOf(match.index), problem: `radius ${value} without borderCurve: 'continuous'` });
        }
      }
      for (const match of source.matchAll(RADIUS_CONSTANT)) {
        const literal = radiusLiteral(match[2]);
        if (literal) findings.push({ file, line: lineOf(match.index), problem: `${match[1]} = ${match[2].trim()}: ${literal} is off the token scale` });
      }
      for (const match of source.matchAll(RADIUS_PROP)) {
        const lineText = source.slice(source.lastIndexOf('\n', match.index) + 1, source.indexOf('\n', match.index));
        if (/shadow/i.test(lineText)) continue;
        const literal = radiusLiteral(match[1]);
        if (literal) findings.push({ file, line: lineOf(match.index), problem: `radius prop ${match[1].trim()}: ${literal} is off the token scale` });
      }
    }
  }
  return { files, findings };
}

describe('corner radii (three shapes, one scale)', () => {
  it('keeps the scale the guides document', () => {
    expect(appTheme.radii).toEqual({ xs: 8, sm: 12, md: 16, lg: 20, xl: 24, xxl: 32, pill: 999 });
  });

  it('reads a radius the way the scan does', () => {
    expect(radiusLiteral('appTheme.radii.xl')).toBeNull();
    expect(radiusLiteral('size / 2')).toBeNull();
    expect(radiusLiteral('MENU_RADIUS - MENU_PADDING')).toBeNull();
    expect(radiusLiteral('first ? GROUP_RADIUS : 0')).toBeNull();
    expect(radiusLiteral('14')).toBe('14');
    expect(radiusLiteral('compact ? 17 : 21')).toBe('17');
    expect(radiusLiteral('appTheme.radii.xl - 4')).toBe('4');
    expect(radiusLiteral('(size + RING_GAP * 2) / 2')).toBe('2');
  });

  it('scans real source files', () => {
    // A positive control: the scan must see the files it guards, and their radii.
    const { files } = scan();
    expect(files).toContain('components/ui.tsx');
    expect(files).toContain('components/media-creation-screen.tsx');
    const source = readFileSync(path.join(root, 'components/anchored-menu.tsx'), 'utf8');
    expect([...source.matchAll(RADIUS_DECLARATION)].length).toBeGreaterThan(0);
  });

  it('writes every radius from the tokens, and every rounded rectangle with continuous corners', () => {
    const { findings } = scan();
    const exempted = EXEMPT.map(({ file, text, count }) => ({
      file,
      text,
      count,
      found: findings.filter((finding) => finding.file === file && finding.problem === text).length,
    }));
    expect(exempted.filter(({ count, found }) => count !== found)).toEqual([]);
    const left = findings.filter((finding) => !EXEMPT.some(({ file, text }) => finding.file === file && finding.problem === text));
    expect(left.map(({ file, line, problem }) => `${file}:${line} ${problem}`)).toEqual([]);
  });
});
