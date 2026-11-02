import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { appTheme } from '../lib/theme';
import { unwrap } from './fixtures/jsx-syntax';

// Every corner in the app is one of three shapes (docs/design/design-mobile.md → Radius; the web's
// `src/__tests__/corner-radius-scale.test.ts`):
// - a capsule: anything pressed on one row, and every circle (`appTheme.radii.pill`, or a size / 2);
// - a fixed step from `appTheme.radii` for the outermost container, by its size;
// - a concentric radius for a shape nested close inside a rounded container: the container's
//   radius less the gap between their edges, written from the tokens (`MENU_RADIUS - MENU_PADDING`).
// Until November 2026 the app drew 36 different radii (14, 17, 21, 15.5…), 263 of them as bare
// numbers, so two controls of one kind rarely matched, on a screen or across screens.
//
// So a radius is written with no number in it but 0 and the `/ 2` of a size (never of a token), a
// uniformly rounded rectangle declares its curve (iOS's continuous corner; Android ignores it), and
// a capsule or circle never asks for the continuous one, so its ends match the circles beside it and
// a placeholder matches the avatar it stands in for. Per-corner radii (a sheet's top corners) need
// no curve: React Native masks them with circular arcs whatever `borderCurve` says
// (RCTViewComponentView.mm). It reads app/, components/ and lib/ through TypeScript's parser, so a
// `/*` inside a string (`'audio/*'`) is a string, not a comment.
const root = path.join(__dirname, '..');
const scanned = ['app', 'components', 'lib'];

const RADIUS_STYLE = /^border(?:(?:Top|Bottom)(?:Left|Right|Start|End)|(?:Start|End)(?:Start|End))?Radius$/;
// A corner handed to a component that draws it (`MediaPreview`, `SkeletonBone`, a zoom source,
// Explore's tile layout, a native button's `cornerRadius`).
const RADIUS_PROPS = new Set(['radius', 'mediaRadius', 'cornerRadius']);
const RADIUS_CONSTANT = /RADIUS$/;

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
    text: 'radius frame.value.radius without borderCurve',
    count: 2,
    why: "the zoom flight's animated clip, which runs on Android only (iOS opens the reel with UIKit's zoom), where no continuous corner exists",
  },
  {
    file: 'components/media-preview.tsx',
    text: 'radius radius without borderCurve',
    count: 3,
    why: "the picture is drawn by expo-image, whose style takes no borderCurve; its fallback and its player's frame keep the same circular corner, so no state changes shape",
  },
  {
    file: 'app/unlock/[unlockId].tsx',
    text: 'radius appTheme.radii.lg without borderCurve',
    count: 1,
    why: "the frame the clip plays in on Play, which takes the still's place exactly and so keeps its circular corner",
  },
  {
    file: 'components/remix-source-row.tsx',
    text: 'radius POSTER_RADIUS without borderCurve',
    count: 1,
    why: "the poster is an expo-image, whose style takes no borderCurve",
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** A number written in a radius, other than 0 and the `/ 2` of a size; half a token is one too. */
function radiusLiteral(value: string): string | null {
  const halfToken = value.match(/\bradii\.\w+\s*\/\s*2\b/);
  if (halfToken) return halfToken[0];
  const stripped = value.replace(/\/\s*2\b/g, '').replace(/\bappTheme\.radii\.\w+/g, '');
  return stripped.match(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])/g)?.find((number) => Number(number) !== 0) ?? null;
}

/** Capsules and circles: the whole value is the pill token or half a size (a branch that names one is not). */
function isCapsule(value: string) {
  return /^appTheme\.radii\.pill$/.test(value.trim()) || /^[\w.]+\s*\/\s*2$/.test(value.trim());
}

type Finding = { file: string; line: number; problem: string };

function propertyName(node: ts.ObjectLiteralElementLike, sourceFile: ts.SourceFile) {
  return node.name ? node.name.getText(sourceFile) : null;
}

/** One source file's findings. */
function scanSource(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const offScale = (node: ts.Node, label: string, value: string) => {
    const literal = radiusLiteral(value);
    if (literal) findings.push({ file, line: lineOf(node), problem: `${label} ${value}: ${literal} is off the token scale` });
    return Boolean(literal);
  };
  const insideShadow = (node: ts.Node) => {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (ts.isCallExpression(current)) return /shadow/i.test(current.expression.getText(sourceFile));
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent)) {
      const name = node.name.getText(sourceFile);
      const value = ts.isPropertyAssignment(node) ? unwrap(node.initializer).getText(sourceFile) : name;
      if (RADIUS_STYLE.test(name) && !offScale(node, 'radius', value) && name === 'borderRadius' && value !== '0') {
        const curve = node.parent.properties.find((property) => propertyName(property, sourceFile) === 'borderCurve');
        const curveValue = curve && ts.isPropertyAssignment(curve) ? unwrap(curve.initializer) : null;
        const curveLiteral = curveValue && ts.isStringLiteralLike(curveValue) ? curveValue.text : null;
        if (isCapsule(value)) {
          if (curveLiteral === 'continuous') findings.push({ file, line: lineOf(node), problem: `capsule ${value} with borderCurve: 'continuous'` });
        } else if (!curve) {
          findings.push({ file, line: lineOf(node), problem: `radius ${value} without borderCurve` });
        } else if (curveLiteral === 'circular') {
          findings.push({ file, line: lineOf(node), problem: `radius ${value} with borderCurve: 'circular'` });
        }
      }
      if (RADIUS_PROPS.has(name) && !insideShadow(node)) offScale(node, 'radius prop', value);
    }
    if (ts.isJsxAttribute(node) && RADIUS_PROPS.has(node.name.getText(sourceFile)) && node.initializer) {
      const expression = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (expression) offScale(node, 'radius prop', unwrap(expression as ts.Expression).getText(sourceFile));
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && RADIUS_CONSTANT.test(node.name.text) && node.initializer) {
      offScale(node, node.name.text, unwrap(node.initializer).getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

const files = scanned.flatMap((dir) => sourceFiles(path.join(root, dir)).map((full) => path.relative(root, full)));
const findings = files.flatMap((file) => scanSource(file, readFileSync(path.join(root, file), 'utf8')));

describe('corner radii (three shapes, one scale)', () => {
  it('keeps the scale the guides document', () => {
    expect(appTheme.radii).toEqual({ xs: 8, sm: 12, md: 16, lg: 20, xl: 24, pill: 999 });
  });

  it('reads a radius the way the scan does', () => {
    expect(radiusLiteral('appTheme.radii.xl')).toBeNull();
    expect(radiusLiteral('size / 2')).toBeNull();
    expect(radiusLiteral('MENU_RADIUS - MENU_PADDING')).toBeNull();
    expect(radiusLiteral('first ? GROUP_RADIUS : 0')).toBeNull();
    expect(radiusLiteral('14')).toBe('14');
    expect(radiusLiteral('compact ? 17 : 21')).toBe('17');
    expect(radiusLiteral('appTheme.radii.xl - 4')).toBe('4');
    expect(radiusLiteral('appTheme.radii.lg / 2')).toBe('radii.lg / 2');
    expect(radiusLiteral('(size + RING_GAP * 2) / 2')).toBe('2');
  });

  it("reads past a `/*` inside a string, and holds a capsule's curve both ways", () => {
    const found = scanSource('fixture.tsx', [
      "const types = ['audio/*'];",
      'const a = { borderRadius: 14 };',
      'const b = { borderRadius: appTheme.radii.md };',
      "const c = { borderRadius: appTheme.radii.pill, borderCurve: 'continuous' };",
      "const d = { borderTopLeftRadius: appTheme.radii.xl };",
      'const g = { borderRadius: selected ? appTheme.radii.pill : appTheme.radii.md };',
      'const e = <Bone radius={6} />;',
      'const f = <AppleButton cornerRadius={12} />;',
    ].join('\n'));
    expect(found.map(({ line, problem }) => `${line} ${problem}`)).toEqual([
      '2 radius 14: 14 is off the token scale',
      '3 radius appTheme.radii.md without borderCurve',
      "4 capsule appTheme.radii.pill with borderCurve: 'continuous'",
      '6 radius selected ? appTheme.radii.pill : appTheme.radii.md without borderCurve',
      '7 radius prop 6: 6 is off the token scale',
      '8 radius prop 12: 12 is off the token scale',
    ]);
  });

  it('scans real source files', () => {
    // A positive control: the scan must see the files it guards.
    expect(files).toContain('components/ui.tsx');
    expect(files).toContain('components/media-creation-screen.tsx');
  });

  it('writes every radius from the tokens, and every corner with its curve', () => {
    const exempted = EXEMPT.map(({ file, text, count }) => ({ file, text, count, found: findings.filter((finding) => finding.file === file && finding.problem === text).length }));
    expect(exempted.filter(({ count, found }) => count !== found)).toEqual([]);
    const left = findings.filter((finding) => !EXEMPT.some(({ file, text }) => finding.file === file && finding.problem === text));
    expect(left.map(({ file, line, problem }) => `${file}:${line} ${problem}`)).toEqual([]);
  });
});
