import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Every corner on the web is one of three shapes, as the app's are (docs/design/design-web.md →
// Radius; the app's `ugc-mobile/__tests__/hig-corner-radius.test.ts`):
// - a capsule: anything pressed on one row, and every circle (`rounded-full`);
// - a fixed step for the outermost container, by its size;
// - a concentric radius for a shape nested close inside a rounded container: the container's
//   radius less the gap between their edges, snapped to a step.
// The steps are the app's: 8, 12, 16, 20, 24 and 32px. Until November 2026 the web drew 22 radii,
// 197 of them off the scale (`rounded-[28px]`, `rounded-[22px]`, `rounded-[14px]`, `rounded-sm`…).
//
// It reads src/app, src/components and src/lib through TypeScript's parser: every string and
// template literal for a `rounded` utility and for CSS (a popup's <style>), and every inline
// `borderRadius`; then the stylesheets. A first version stripped comments with a regex, so the
// `/*` of `accept="image/*"` hid the rest of three files and 28 off-scale corners (2026-11-02).
const ROOT = process.cwd();
const SCANNED = ['src/app', 'src/components', 'src/lib'];

// Tailwind's own steps that are on the scale, the shell's `ui-*` tokens (globals.css's @theme), and
// capsules. Tailwind's `rounded` and `rounded-sm` (4px), `rounded-md` (6px) and `rounded-xs` (2px)
// are not, nor is any bracketed value.
const ON_SCALE = new Set(['none', 'lg', 'xl', '2xl', '3xl', '4xl', 'full', 'ui-sm', 'ui-md', 'ui-lg', 'ui-xl', 'ui-2xl']);
const SCALE_PX = new Set([0, 8, 12, 16, 20, 24, 32]);
// The `--ui-radius-*` variables globals.css defines; one it does not define computes to square.
const UI_RADIUS_VARIABLES: Record<string, number | 'pill'> = { sm: 8, md: 12, lg: 16, xl: 20, '2xl': 24, pill: 'pill' };

// Findings that are the point, each counted so a new one beside them still fails.
const EXEMPT: Array<{ file: string; token: string; count: number; why: string }> = [
  {
    file: 'src/components/CreatorColumn.tsx',
    token: 'rounded-xs',
    count: 1,
    why: 'the aspect-ratio mark beside a ratio option: a drawing of the ratio a few pixels across, not a surface',
  },
  ...['src/app/create-workflow/WorkflowNodeEditors.tsx', 'src/app/create-workflow/WorkflowTemplatePublishDrawer.tsx'].map((file) => ({
    file,
    token: 'rounded',
    count: 1,
    why: "a 16px native checkbox, which keeps the platform's own small rounded square",
  })),
  {
    file: 'src/app/post/new/NewPostClient.tsx',
    token: 'rounded',
    count: 2,
    why: "the two 16px native checkboxes of From this creation, which keep the platform's own small rounded square",
  },
  {
    file: 'src/app/welcome-reward-celebration.css',
    token: 'border-radius: 2px',
    count: 1,
    why: 'confetti pieces a few pixels across, a drawing rather than a surface',
  },
];

const ROUNDED = /^rounded(?:-(?:t|b|l|r|tl|tr|bl|br|s|e|ss|se|es|ee))?(?:-(.+))?$/;
// A token that reads as a utility, so a bare `rounded` in a sentence ("rounded down") is not one.
const UTILITY = /^(?:[^\s:]+:)*!?-?[a-z][a-z0-9]*-[\w./[\]()%#-]+$/;
const CSS_RADIUS = /(?:^|[;{\s])(border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius|--ui-radius-[\w-]+|--radius-[\w-]+)\s*:\s*([^;}]+)/g;
const INLINE_RADIUS = /^border(?:Top|Bottom|Start|End)?(?:Left|Right|Start|End)?Radius$/;

function sourceFiles(directory: string, extension: RegExp): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || relative === 'src/app/api' ? [] : sourceFiles(relative, extension);
    return extension.test(entry.name) ? [relative] : [];
  });
}

/** A class with its variants stripped: what follows the last `:` outside brackets, without `!`. */
function utilityOf(token: string) {
  let depth = 0;
  let cut = 0;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (char === ':' && depth === 0) cut = index + 1;
  }
  return token.slice(cut).replace(/^!/, '');
}

/** The size a `rounded` class names (`''` for bare `rounded`), or null for a token that is not one. */
function roundedSize(token: string): string | null {
  const match = utilityOf(token).match(ROUNDED);
  return match ? (match[1] ?? '') : null;
}

function px(value: string): number | 'pill' | null {
  const trimmed = value.trim();
  if (/^(?:50%|100%)$/.test(trimmed)) return 'pill';
  const variable = trimmed.match(/^var\(--ui-radius-([\w-]+)\)$/);
  if (variable) return UI_RADIUS_VARIABLES[variable[1]] ?? null;
  const length = trimmed.match(/^(-?\d*\.?\d+)(px|rem)?$/);
  if (!length) return null;
  const pixels = Number(length[1]) * (length[2] === 'rem' ? 16 : 1);
  return pixels >= 999 ? 'pill' : pixels;
}

type Finding = { file: string; line: number; token: string };

function checkCss(css: string, file: string, line: (index: number) => number, findings: Finding[]) {
  for (const match of css.matchAll(CSS_RADIUS)) {
    for (const part of match[2].trim().split(/\s+(?![^(]*\))/)) {
      const resolved = px(part);
      if (resolved === null || (resolved !== 'pill' && !SCALE_PX.has(resolved))) findings.push({ file, line: line(match.index), token: `${match[1]}: ${part}` });
    }
  }
}

/** One source file's findings, and the last line where a `rounded` class was read. */
function scanSource(file: string, text: string) {
  const findings: Finding[] = [];
  let roundedSeen = 0;
  let lastRoundedLine = 0;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineAt = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const start = node.getStart(sourceFile);
      const tokens = node.text.split(/\s+/).filter(Boolean);
      const utilityLike = tokens.some((token) => UTILITY.test(token));
      for (const token of tokens) {
        const size = roundedSize(token);
        if (size === null || (size === '' && !utilityLike)) continue;
        roundedSeen += 1;
        lastRoundedLine = Math.max(lastRoundedLine, lineAt(start));
        if (!ON_SCALE.has(size)) findings.push({ file, line: lineAt(start), token });
      }
      checkCss(node.text, file, () => lineAt(start), findings);
    }
    if (ts.isPropertyAssignment(node) && INLINE_RADIUS.test(node.name.getText(sourceFile))) {
      const value = node.initializer;
      const literal = ts.isNumericLiteral(value) || ts.isStringLiteralLike(value) ? value.text : null;
      if (literal !== null) {
        const resolved = px(literal);
        if (resolved === null || (resolved !== 'pill' && !SCALE_PX.has(resolved))) findings.push({ file, line: lineAt(value.getStart(sourceFile)), token: `${node.name.getText(sourceFile)}: ${literal}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { findings, roundedSeen, lastRoundedLine };
}

function scanTree() {
  const findings: Finding[] = [];
  const lastRoundedLine = new Map<string, number>();
  let roundedSeen = 0;
  for (const directory of SCANNED) {
    for (const file of sourceFiles(directory, /\.tsx?$/)) {
      const result = scanSource(file, readFileSync(path.join(ROOT, file), 'utf8'));
      findings.push(...result.findings);
      roundedSeen += result.roundedSeen;
      lastRoundedLine.set(file, result.lastRoundedLine);
    }
  }
  for (const file of sourceFiles('src', /\.css$/)) {
    const source = readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
    checkCss(source, file, (index) => source.slice(0, index).split('\n').length, findings);
    for (const match of source.matchAll(/@apply\s+([^;]+);/g)) {
      for (const token of match[1].split(/\s+/)) {
        const size = roundedSize(token);
        if (size !== null && !ON_SCALE.has(size)) findings.push({ file, line: source.slice(0, match.index).split('\n').length, token });
      }
    }
  }
  return { findings, roundedSeen, lastRoundedLine };
}

const tree = scanTree();

describe('corner radii on the web (three shapes, one scale)', () => {
  it('reads a class the way the scan does', () => {
    const sizes = (token: string) => roundedSize(token);
    expect(sizes('rounded-full')).toBe('full');
    expect(sizes('md:rounded-3xl')).toBe('3xl');
    expect(sizes('rounded-t-ui-xl')).toBe('ui-xl');
    expect(sizes('max-[768px]:rounded-sm')).toBe('sm');
    expect(sizes('group-hover/card:!rounded-[14px]')).toBe('[14px]');
    expect(sizes('data-[state=open]:rounded')).toBe('');
    expect(sizes('grounded')).toBeNull();
    expect(px('var(--ui-radius-2xl)')).toBe(24);
    expect(px('var(--ui-radius-3xl)')).toBeNull();
    expect(px('1.75rem')).toBe(28);
    expect(px('999px')).toBe('pill');
  });

  it('reads past a `/*` inside a string, and CSS inside one', () => {
    const { findings } = scanSource(
      'fixture.tsx',
      [
        'export const A = () => <input accept="image/*,video/*" className="rounded-[18px]" />;',
        "export const B = () => <div className=\"rounded-md\">{/* a comment */}</div>;",
        'export const C = `main { border-radius: 28px; }`;',
        'export const D = { borderRadius: 14 };',
      ].join('\n'),
    );
    expect(findings.map(({ line, token }) => `${line} ${token}`)).toEqual(['1 rounded-[18px]', '2 rounded-md', '3 border-radius: 28px', '4 borderRadius: 14']);
  });

  it('scans real class lists, to the end of each file', () => {
    // Positive controls: the tree's classes are read, and a long file is read to its last class.
    expect(tree.roundedSeen).toBeGreaterThan(1000);
    expect(tree.lastRoundedLine.get('src/app/post/new/NewPostClient.tsx')).toBeGreaterThan(3800);
  });

  it('draws every corner from the scale', () => {
    const { findings } = tree;
    const exempted = EXEMPT.map(({ file, token, count }) => ({ file, token, count, found: findings.filter((finding) => finding.file === file && finding.token === token).length }));
    expect(exempted.filter(({ count, found }) => count !== found)).toEqual([]);
    const left = findings.filter((finding) => !EXEMPT.some(({ file, token }) => finding.file === file && finding.token === token));
    expect(left.map(({ file, line, token }) => `${file}:${line} ${token}`)).toEqual([]);
  });
});
