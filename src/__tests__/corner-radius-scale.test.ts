import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Every corner on the web is one of three shapes, as Apple's are and as the app's are
// (docs/design/design-web.md → Radius; the app's `ugc-mobile/__tests__/hig-corner-radius.test.ts`):
// - a capsule: anything pressed on one row, and every circle (`rounded-full`);
// - a fixed step for the outermost container, by its size;
// - a concentric radius for a shape nested close inside a rounded container: the container's
//   radius less the gap between their edges, snapped to a step.
// The steps are the app's: 8, 12, 16, 20, 24 and 32px. Until November 2026 the web drew 22 radii,
// 169 of them off the scale (`rounded-[28px]`, `rounded-[22px]`, `rounded-[14px]`, `rounded-sm`…),
// so two controls of one kind rarely matched.
//
// It reads every quoted string in src/app, src/components and src/lib for a `rounded` utility,
// every inline `borderRadius`, and every `border-radius` and radius token in the stylesheets.
const ROOT = process.cwd();
const SCANNED = ['src/app', 'src/components', 'src/lib'];

// Tailwind's own steps that are on the scale, the shell's `ui-*` tokens (globals.css's @theme), and
// capsules. Tailwind's `rounded` and `rounded-sm` (4px), `rounded-md` (6px) and `rounded-xs` (2px)
// are not, nor is any bracketed value.
export const ON_SCALE = new Set(['none', 'lg', 'xl', '2xl', '3xl', '4xl', 'full', 'ui-sm', 'ui-md', 'ui-lg', 'ui-xl', 'ui-2xl']);
const SCALE_PX = new Set([0, 8, 12, 16, 20, 24, 32]);

// Findings that are the point, each counted so a new one beside them still fails.
const EXEMPT: Array<{ file: string; token: string; count: number; why: string }> = [
  {
    file: 'src/components/CreatorColumn.tsx',
    token: 'rounded-xs',
    count: 1,
    why: 'the aspect-ratio mark beside a ratio option: a drawing of the ratio a few pixels across, not a surface',
  },
  {
    file: 'src/app/create-workflow/WorkflowNodeEditors.tsx',
    token: 'rounded',
    count: 1,
    why: "a 16px native checkbox, which keeps the platform's own small rounded square",
  },
  {
    file: 'src/app/create-workflow/WorkflowTemplatePublishDrawer.tsx',
    token: 'rounded',
    count: 1,
    why: "a 16px native checkbox, which keeps the platform's own small rounded square",
  },
  {
    file: 'src/app/welcome-reward-celebration.css',
    token: 'border-radius: 2px',
    count: 1,
    why: 'confetti pieces a few pixels across, a drawing rather than a surface',
  },
];

const ROUNDED = /^(?:[\w-]+:)*!?rounded(?:-(?:t|b|l|r|tl|tr|bl|br|s|e|ss|se|es|ee))?(?:-(.+))?$/;
// A token that reads as a utility, so a bare `rounded` in a sentence ("rounded down") is not one.
const UTILITY = /^(?:[\w[\]-]+:)*!?-?[a-z][a-z0-9]*-[\w./[\]()%#-]+$/;

function sourceFiles(directory: string, extension: RegExp): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || relative === 'src/app/api' ? [] : sourceFiles(relative, extension);
    return extension.test(entry.name) ? [relative] : [];
  });
}

/** Comments out, keeping every line where it was. */
function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (match, before: string) => before + ' '.repeat(match.length - before.length));
}

/** The size a `rounded` class names, or null for a token that is not one. */
export function roundedSize(token: string): string | null {
  const match = token.match(ROUNDED);
  if (!match) return null;
  return match[1] ?? '';
}

export function isOnScale(token: string) {
  const size = roundedSize(token);
  return size !== null && ON_SCALE.has(size);
}

function px(value: string): number | 'pill' | null {
  const trimmed = value.trim();
  if (/^(?:9{3,}px|50%|100%|calc\(infinity \* 1px\))$/.test(trimmed)) return 'pill';
  const variable = trimmed.match(/^var\(--ui-radius-(sm|md|lg|xl|2xl|3xl|pill)\)$/);
  if (variable) return { sm: 8, md: 12, lg: 16, xl: 20, '2xl': 24, '3xl': 32, pill: 'pill' as const }[variable[1] as 'sm'];
  const length = trimmed.match(/^(-?\d*\.?\d+)(px|rem)?$/);
  if (!length) return null;
  const pixels = Number(length[1]) * (length[2] === 'rem' ? 16 : 1);
  return pixels >= 999 ? 'pill' : pixels;
}

type Finding = { file: string; line: number; token: string };

function scan() {
  const findings: Finding[] = [];
  let roundedSeen = 0;
  for (const directory of SCANNED) {
    for (const file of sourceFiles(directory, /\.tsx?$/)) {
      const source = withoutComments(readFileSync(path.join(ROOT, file), 'utf8'));
      const lineOf = (index: number) => source.slice(0, index).split('\n').length;
      for (const literal of source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
        const tokens = literal[2].split(/[\s'"`{}$]+/).filter(Boolean);
        const utilityLike = tokens.some((token) => UTILITY.test(token));
        for (const token of tokens) {
          const size = roundedSize(token);
          if (size === null) continue;
          if (size === '' && !utilityLike) continue;
          roundedSeen += 1;
          if (!ON_SCALE.has(size)) findings.push({ file, line: lineOf(literal.index), token });
        }
      }
      for (const match of source.matchAll(/\bborder(?:Top|Bottom)?(?:Left|Right|Start|End)?Radius\s*:\s*([^,}\n]+)/g)) {
        const value = match[1].trim().replace(/^['"]|['"]$/g, '');
        const resolved = /^\d/.test(value) ? px(value) : null;
        if (resolved !== null && resolved !== 'pill' && !SCALE_PX.has(resolved)) findings.push({ file, line: lineOf(match.index), token: `borderRadius: ${value}` });
      }
    }
  }
  for (const file of sourceFiles('src', /\.css$/)) {
    const source = withoutComments(readFileSync(path.join(ROOT, file), 'utf8'));
    const lineOf = (index: number) => source.slice(0, index).split('\n').length;
    for (const match of source.matchAll(/(?:^|[;{\s])(border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius|--ui-radius-[\w-]+|--radius-[\w-]+)\s*:\s*([^;}]+)/g)) {
      for (const part of match[2].trim().split(/\s+(?![^(]*\))/)) {
        const resolved = px(part);
        if (resolved === null || (resolved !== 'pill' && !SCALE_PX.has(resolved))) findings.push({ file, line: lineOf(match.index), token: `${match[1]}: ${part}` });
      }
    }
    for (const match of source.matchAll(/@apply\s+([^;]+);/g)) {
      for (const token of match[1].split(/\s+/)) {
        if (roundedSize(token) !== null && !isOnScale(token)) findings.push({ file, line: lineOf(match.index), token });
      }
    }
  }
  return { findings, roundedSeen };
}

describe('corner radii on the web (three shapes, one scale)', () => {
  it('reads a class the way the scan does', () => {
    expect(isOnScale('rounded-full')).toBe(true);
    expect(isOnScale('md:rounded-3xl')).toBe(true);
    expect(isOnScale('rounded-t-ui-xl')).toBe(true);
    expect(isOnScale('rounded-[28px]')).toBe(false);
    expect(isOnScale('rounded')).toBe(false);
    expect(isOnScale('rounded-sm')).toBe(false);
    expect(isOnScale('rounded-md')).toBe(false);
    expect(roundedSize('grounded')).toBeNull();
    expect(px('var(--ui-radius-2xl)')).toBe(24);
    expect(px('1.75rem')).toBe(28);
    expect(px('999px')).toBe('pill');
  });

  it('scans real class lists', () => {
    // A positive control: the scan must see the classes it guards.
    expect(scan().roundedSeen).toBeGreaterThan(1000);
  });

  it('draws every corner from the scale', () => {
    const { findings } = scan();
    const exempted = EXEMPT.map(({ file, token, count }) => ({ file, token, count, found: findings.filter((finding) => finding.file === file && finding.token === token).length }));
    expect(exempted.filter(({ count, found }) => count !== found)).toEqual([]);
    const left = findings.filter((finding) => !EXEMPT.some(({ file, token }) => finding.file === file && finding.token === token));
    expect(left.map(({ file, line, token }) => `${file}:${line} ${token}`)).toEqual([]);
  });
});
