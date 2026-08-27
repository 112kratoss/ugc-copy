import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { appTheme } from '../lib/theme';

// lucide-react-native draws through react-native-svg. Rendering those tags as
// host elements keeps every prop the real Icon computed — including the stroke
// width it resolved — readable in the tree.
type SvgProps = Record<string, unknown> & { children?: React.ReactNode };
const svgTag = (tag: string) => (props: SvgProps) => React.createElement(tag, props, props.children);

vi.mock('react-native-svg', () => ({
  default: svgTag('svg'),
  Svg: svgTag('svg'),
  Circle: svgTag('circle'),
  Ellipse: svgTag('ellipse'),
  G: svgTag('g'),
  Line: svgTag('line'),
  Path: svgTag('path'),
  Polygon: svgTag('polygon'),
  Polyline: svgTag('polyline'),
  Rect: svgTag('rect'),
}));

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
 * Apple's Icons chapter: "all interface icons in your app need to use a
 * consistent size, level of detail, stroke thickness (or weight), and
 * perspective."
 *
 * The weight is supplied once, by the LucideProvider in the root layout, so a
 * screen cannot set it and a new screen cannot forget it. These tests hold both
 * halves of that: the provider really does reach an icon at runtime, and no
 * source file overrides it.
 */
describe('HIG icon weight — one weight, supplied once', () => {
  async function renderCamera(wrap: (icon: React.ReactElement) => React.ReactElement) {
    const { Camera } = await import('lucide-react-native');
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => { tree = renderer.create(wrap(React.createElement(Camera, { size: 20 }))); });
    return (tree as renderer.ReactTestRenderer).root.findAll((node) => node.type === 'svg')[0].props.strokeWidth;
  }

  // The first `import('lucide-react-native')` in a worker pulls ~1,600 icon
  // modules through the transform, which overruns vitest's 5s default whenever
  // the full suite is running the other 145 files alongside it. A guard that
  // goes red under load stops meaning anything, so this one is given room.
  it('gives an icon the token weight through the provider', async () => {
    const { LucideProvider } = await import('lucide-react-native');
    const stroke = await renderCamera((icon) =>
      React.createElement(LucideProvider, { strokeWidth: appTheme.icon.stroke, children: icon }));

    expect(stroke).toBe(appTheme.icon.stroke);
  }, 30000);

  it('renders lucide\'s own default without the provider, so the test above is proving the provider', async () => {
    // Also the canary for the packaging patch: lucide 1.14.0 re-exports a
    // LucideProvider its context module never defines, so patches/ restores it.
    // Lose the patch and the test above sees this 2 instead of the token.
    expect(await renderCamera((icon) => icon)).toBe(2);
  });

  it('mounts the provider at the root of the app, wired to the token', () => {
    const layout = readFileSync(path.join(mobileRoot, 'app/_layout.tsx'), 'utf8');

    expect(layout).toContain('<LucideProvider strokeWidth={appTheme.icon.stroke}>');
  });
});

/**
 * react-native-svg's own drawing primitives take a strokeWidth as part of the
 * artwork — an illustration is not an interface icon, and its line weights are
 * drawn in viewBox units. Everything else that sets a literal stroke weight is
 * an icon overriding the app's one weight.
 */
const ARTWORK_TAGS = new Set(['Circle', 'Ellipse', 'G', 'Line', 'Path', 'Polygon', 'Polyline', 'Rect', 'Svg']);

function literalStrokeOverrides(source: string) {
  const found: string[] = [];
  const pattern = /<([A-Z][A-Za-z0-9]*)(?=[\s/>])/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    // Walk to the `>` that closes this opening tag, ignoring any inside a
    // prop's braces or parens — `style={({ pressed }) => ...}` is full of
    // characters that would otherwise look like the end of the tag.
    let depth = 0;
    let end = -1;
    for (let index = match.index; index < source.length; index += 1) {
      const character = source[index];
      if (character === '{' || character === '(') depth += 1;
      else if (character === '}' || character === ')') depth -= 1;
      else if (character === '>' && depth === 0) { end = index; break; }
    }
    if (end === -1) continue;
    if (ARTWORK_TAGS.has(match[1])) continue;

    const tag = source.slice(match.index, end + 1);
    if (/strokeWidth=\{\s*[\d.]+\s*\}/.test(tag) || /strokeWidth="[\d.]+"/.test(tag)) {
      found.push(`${source.slice(0, match.index).split('\n').length}: <${match[1]} sets its own strokeWidth`);
    }
  }

  // An icon's props can also travel as a plain object, which never reaches JSX
  // as a prop — `{ color, fill, strokeWidth: 2.6 }` spread onto a glyph is the
  // same override written sideways.
  for (const [index, line] of source.split('\n').entries()) {
    if (/^\s*strokeWidth:\s*[\d.]+\s*,?\s*$/.test(line)) found.push(`${index + 1}: icon props object sets its own strokeWidth`);
  }

  return found.sort();
}

describe('HIG icon weight — nothing overrides it', () => {
  it('flags a screen that sets its own icon weight', () => {
    const offending = `<Heart size={22} color={accent} strokeWidth={2.6} />`;
    expect(literalStrokeOverrides(offending)).toEqual(['1: <Heart sets its own strokeWidth']);
  });

  it('flags the same override written as a props object', () => {
    const offending = 'return {\n  color: activeColor,\n  strokeWidth: 2.6,\n};';
    expect(literalStrokeOverrides(offending)).toEqual(['3: icon props object sets its own strokeWidth']);
  });

  it('leaves illustration artwork alone, which is drawn in viewBox units', () => {
    const artwork = `<Circle cx="304" cy="83" r="74" stroke={accent} strokeWidth="8" />`;
    expect(literalStrokeOverrides(artwork)).toEqual([]);
  });

  it('leaves a weight derived from the token alone', () => {
    const derived = `strokeWidth: (children.props.strokeWidth ?? appTheme.icon.stroke) + 1.4,`;
    expect(literalStrokeOverrides(derived)).toEqual([]);
  });

  it('lets no interface icon in the app set its own weight', () => {
    const violations = files.flatMap((filePath) => literalStrokeOverrides(readFileSync(filePath, 'utf8'))
      .map((detail) => `${path.relative(mobileRoot, filePath).replaceAll(path.sep, '/')}:${detail}`));

    expect(violations).toEqual([]);
  });
});

/**
 * Apple's Icons chapter publishes a table of standard symbols for common
 * actions; Share is `square.and.arrow.up`, which Lucide draws as `Share`.
 * `Share2` is the Material shape. Neither belongs at a call site — the app has
 * one share affordance and it speaks the running platform's dialect.
 */
function importsShareGlyphDirectly(source: string) {
  const imported = (source.match(/import\s+\{([^}]*)\}\s+from\s+'lucide-react-native'/) ?? [, ''])[1];
  return imported.split(',').some((name) => ['Share', 'Share2'].includes(name.trim()));
}

describe('HIG standard icons — share speaks the platform dialect', () => {
  it('picks the platform shape in one place', () => {
    const glyphSource = readFileSync(path.join(mobileRoot, 'lib/platform-glyphs.ts'), 'utf8');

    expect(glyphSource).toMatch(/ReactNative\.Platform\.OS === 'ios'/);
    expect(glyphSource).toMatch(/export const ShareGlyph = IS_IOS \? Share : Share2;/);
  });

  it('flags a screen that imports a share glyph itself', () => {
    expect(importsShareGlyphDirectly("import { Repeat2, Share2 } from 'lucide-react-native';")).toBe(true);
  });

  it('leaves a name that merely starts the same way alone', () => {
    expect(importsShareGlyphDirectly("import { ShareGlyphIsNotThis } from 'lucide-react-native';")).toBe(false);
  });

  it('lets no screen reach for a share glyph directly', () => {
    const direct = files
      .filter((filePath) => path.relative(mobileRoot, filePath) !== path.join('lib', 'platform-glyphs.ts'))
      .filter((filePath) => importsShareGlyphDirectly(readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(mobileRoot, filePath).replaceAll(path.sep, '/'));

    expect(direct).toEqual([]);
  });
});
