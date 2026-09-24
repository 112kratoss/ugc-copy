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

/** Comments may name a colour; only code counts. A `//` after a colon is a URL, not a comment. */
export function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|['"](?:white|black)['"]/g;
// A read of the dark palette through the migration shim, or an accent looked up
// without saying which palette — both draw dark whatever the scheme.
const STATIC_PALETTE_READ = /\bappTheme\.(?:colors|semantic|state|shadow)\b|\b(?:accentColor|onAccentColor)\(\s*[^,()]+\)/g;

export function countThemeDebt(source: string) {
  const code = stripComments(source);
  return {
    palette: (code.match(STATIC_PALETTE_READ) ?? []).length,
    literals: (code.match(COLOUR_LITERAL) ?? []).length,
  };
}

/**
 * Files whose colour literals are the point rather than debt. Each says why.
 */
const REEL = 'the reel stays dark over video in both schemes — drawn inside `ThemeScope scheme="dark"`, over pictures';
const EXEMPT: Record<string, string> = {
  'lib/theme.ts': 'the palettes themselves',
  'app/+html.tsx': 'the static web shell, never rendered by the native app',
  'lib/tab-bar-ambient.ts': "the adaptive dock's colour arithmetic: its neutral fills and label colours are the inputs to its contrast limits",
  'app/viewer.tsx': REEL,
  'components/reel-chrome.tsx': REEL,
  'components/viewer-top-control.tsx': REEL,
  'components/media-zoom.tsx': REEL,
  'components/zoom-post-chrome.tsx': REEL,
  'lib/viewer-actions.ts': REEL,
  'lib/reel-icon-assets.ts': 'pre-rasterised reel icons, keyed by the colour each was drawn in',
  'components/media-lightbox.tsx': 'a picture on black in both schemes, like the reel',
  'app/onboarding.tsx': 'the first run stays dark in both schemes: its art is a night scene made for black',
  'components/onboarding-booklet.tsx': 'the first run stays dark in both schemes: its art is a night scene made for black',
  'components/letterbox-bands.tsx': "the shade belongs to the picture: it darkens a mirrored, blurred copy of the picture's own edge",
};

/**
 * Light mode is adopted by ratchet, as the icon ramp was
 * (`hig-icon-size.test.ts`). A colour a component takes from the dark palette
 * at module scope, or writes out as a literal, stays dark when the phone is
 * light: `appTheme.colors` is a constant, so React Compiler memoises every
 * style built from it for the life of the process. Colours come from
 * `useAppTheme()` instead, and a picture's own overlays from `mediaColors`.
 *
 * Every file reached zero on 2026-09-23, when light mode landed, so the budget
 * table is empty and stays empty: a new fixed colour needs either a token or an
 * entry in `EXEMPT` that says why the colour is the point.
 */
const DEBT: Record<string, { palette: number; literals: number }> = {};

describe('light mode — theme colours adopted by ratchet', () => {
  it('counts a palette read through the shim, and an accent looked up without a palette', () => {
    expect(countThemeDebt("const a = { color: appTheme.colors.text, shadow: appTheme.shadow.panel };").palette).toBe(2);
    expect(countThemeDebt('const c = accentColor(card.accent);').palette).toBe(1);
    expect(countThemeDebt('const c = accentColor(card.accent, theme.colors);').palette).toBe(0);
    expect(countThemeDebt('const t = appTheme.radii.xl + appTheme.spacing.gap;').palette).toBe(0);
  });

  it('counts colour literals in code and ignores them in comments and URLs', () => {
    const source = [
      "// the old #ff7a59 coral",
      "/* rgba(0,0,0,0.5) */",
      "const url = 'https://magicbooklet.com/help#faq';",
      "const a = { color: '#ffffff', backgroundColor: 'rgba(0,0,0,0.38)', borderColor: 'white' };",
    ].join('\n');
    expect(countThemeDebt(source).literals).toBe(3);
  });

  it('keeps every surface that stays dark inside a dark scope', () => {
    const read = (relative: string) => readFileSync(path.join(mobileRoot, relative), 'utf8');
    expect(read('app/viewer.tsx')).toMatch(/<ThemeScope scheme="dark">[\s\S]*<ImmersivePreviewViewer \/>/);
    expect(read('app/onboarding.tsx')).toMatch(/<ThemeScope scheme="dark">[\s\S]*<OnboardingFlow \/>/);
    expect(read('components/media-lightbox.tsx')).toMatch(/<ThemeScope scheme="dark">[\s\S]*<MediaLightboxContent/);
    expect(read('app/_layout.tsx')).toMatch(/<ThemeScope scheme="dark">\s*<MediaZoomFlightLayer/);
    // A sheet the reel opens is app UI and returns to the app's scheme.
    expect(read('app/viewer.tsx')).toMatch(/<AppSchemeScope>[\s\S]*<ViewerActionSheet[\s\S]*<CommentsSheet[\s\S]*<UnlockRemixPrompt[\s\S]*<\/AppSchemeScope>/);
  });

  it('lets no file draw more fixed colours than it already did', () => {
    const over = files.flatMap((filePath) => {
      const relativePath = path.relative(mobileRoot, filePath).replaceAll(path.sep, '/');
      if (relativePath in EXEMPT) return [];
      const { palette, literals } = countThemeDebt(readFileSync(filePath, 'utf8'));
      const allowed = DEBT[relativePath] ?? { palette: 0, literals: 0 };
      const problems: string[] = [];
      if (palette > allowed.palette) problems.push(`${relativePath}: ${palette} dark-palette reads, budget ${allowed.palette}`);
      if (literals > allowed.literals) problems.push(`${relativePath}: ${literals} colour literals, budget ${allowed.literals}`);
      return problems;
    });

    expect(over).toEqual([]);
  });
});

/**
 * A picture's own shade is black in both schemes (`mediaColors`), so whatever
 * is drawn on it must be too: the dark palette (`themes.dark.colors`) or
 * `mediaColors`. The scheme's colours go dark on light — ink text, deep
 * accents — and vanish on the shade. The Android pass of 2026-09-23 found this
 * on a video's loading spinner, an image's error plate and a template's title
 * card, after the same slip on Explore's pins.
 *
 * A line that sets a dark picture overlay as its background, or a gradient with
 * a dark foot, followed within a few lines by a foreground from `theme.colors`,
 * is the tell. The reach stops short of the caption a card draws under its
 * picture, which rightly follows the app.
 */
const DARK_PICTURE_OVERLAY = /backgroundColor:\s*(?:hexWithAlpha\(mediaColors\.mediaGround\b|mediaColors\.(?:mediaGround|mediaChip|mediaScrim|mediaScrimStrong)\b)|colors=\{\[[^\]]*mediaColors\.mediaGround\b/;
const SCHEME_FOREGROUND = /\b(?:color|fill)[=:]\s*\{?\s*theme\.colors\.\w+/;
const OVERLAY_REACH = 8;

export function schemeColoursOnPictureOverlays(source: string) {
  const lines = stripComments(source).split('\n');
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (!DARK_PICTURE_OVERLAY.test(line)) return;
    for (let next = index; next < Math.min(index + OVERLAY_REACH, lines.length); next += 1) {
      if (SCHEME_FOREGROUND.test(lines[next])) found.push(next + 1);
    }
  });
  return [...new Set(found)];
}

describe('light mode — what is drawn on a picture keeps the dark palette', () => {
  it('flags a scheme colour on a picture overlay and passes the dark palette', () => {
    const flagged = [
      "<View style={{ backgroundColor: hexWithAlpha(mediaColors.mediaGround, 0.55) }}>",
      '  <ActivityIndicator color={theme.colors.text} />',
      '</View>',
    ].join('\n');
    const fixed = flagged.replace('theme.colors.text', 'themes.dark.colors.text');
    expect(schemeColoursOnPictureOverlays(flagged)).toEqual([2]);
    expect(schemeColoursOnPictureOverlays(fixed)).toEqual([]);

    const titleCard = [
      '<LinearGradient colors={[hexWithAlpha(mediaColors.mediaGround, 0.03), hexWithAlpha(mediaColors.mediaGround, 0.94)]}>',
      '  <Kicker color={theme.colors.primary}>video template</Kicker>',
      '</LinearGradient>',
    ].join('\n');
    expect(schemeColoursOnPictureOverlays(titleCard)).toEqual([2]);
  });

  it('finds none in the app', () => {
    const offenders = files.flatMap((filePath) => {
      const relativePath = path.relative(mobileRoot, filePath).replaceAll(path.sep, '/');
      if (relativePath in EXEMPT) return [];
      return schemeColoursOnPictureOverlays(readFileSync(filePath, 'utf8')).map((line) => `${relativePath}:${line}`);
    });

    expect(offenders).toEqual([]);
  });
});

/**
 * A coral fill is `primaryFill`, the bright coral with ink (`onPrimary`) on it in
 * both schemes. `primary` and `primaryStrong` go deep on light, and ink on them
 * falls to about 3:1. They stay right for marks (a dot, a bar, a thin rule), which
 * carry no text. So the tell is a deep-coral fill, written directly or through a
 * local alias, followed by an `onPrimary` foreground. The iPhone pass of
 * 2026-09-24 found it on the Alerts tab's Enable button and on edit-profile's Save.
 */
const DEEP_CORAL = /theme\.colors\.(?:primary|primaryStrong)\b/;
const FILL_TO_TEXT_REACH = 25;

function usedAsSolidColour(expression: string, token: RegExp) {
  const pattern = new RegExp(token.source, 'g');
  for (let match = pattern.exec(expression); match; match = pattern.exec(expression)) {
    const before = expression.slice(0, match.index);
    // A `${colour}24` tint or a hexWithAlpha(colour, α) wash is not a solid fill.
    if (before.endsWith('${') || /hexWithAlpha\(\s*$/.test(before)) continue;
    return true;
  }
  return false;
}

export function deepCoralFillsUnderInk(source: string) {
  const code = stripComments(source);
  const lines = code.split('\n');
  const aliases = [...code.matchAll(new RegExp(`const (\\w+) = [^;\\n]*${DEEP_CORAL.source}[^;\\n]*;`, 'g'))]
    .map((match) => new RegExp(`\\b${match[1]}\\b`));
  const found: number[] = [];
  for (const match of code.matchAll(/backgroundColor:([^,}]*)/g)) {
    const expression = match[1];
    const solid = usedAsSolidColour(expression, DEEP_CORAL) || aliases.some((alias) => usedAsSolidColour(expression, alias));
    if (!solid) continue;
    const line = code.slice(0, match.index).split('\n').length;
    if (lines.slice(line - 1, line - 1 + FILL_TO_TEXT_REACH).some((text) => text.includes('onPrimary'))) found.push(line);
  }
  return found;
}

describe('light mode — ink sits on the bright coral, never the deep one', () => {
  it('flags a deep-coral fill under ink, direct or through an alias, and passes marks, washes and primaryFill', () => {
    const direct = [
      "style={{ backgroundColor: pressed ? theme.colors.primaryStrong : theme.colors.primary }}",
      "<AppText color={theme.colors.onPrimary}>Save</AppText>",
    ].join('\n');
    const aliased = [
      "const color = accent === 'image' ? theme.colors.image : theme.colors.primary;",
      "style={{ backgroundColor: isPrimary ? color : `${color}24` }}",
      "<AppText color=\"onPrimary\">Enable</AppText>",
    ].join('\n');
    expect(deepCoralFillsUnderInk(direct)).toEqual([1]);
    expect(deepCoralFillsUnderInk(aliased)).toEqual([2]);
    expect(deepCoralFillsUnderInk(direct.replace(/theme\.colors\.primary(Strong)?\b/g, 'theme.colors.primaryFill'))).toEqual([]);
    expect(deepCoralFillsUnderInk("<View style={{ width: 6, height: 6, backgroundColor: theme.colors.primary }} />")).toEqual([]);
    expect(deepCoralFillsUnderInk([
      "style={{ backgroundColor: hexWithAlpha(theme.colors.primary, 0.12) }}",
      "<Text style={{ color: theme.colors.onPrimary }} />",
    ].join('\n'))).toEqual([]);
  });

  it('finds none in the app', () => {
    const offenders = files.flatMap((filePath) => {
      const relativePath = path.relative(mobileRoot, filePath).replaceAll(path.sep, '/');
      if (relativePath in EXEMPT) return [];
      return deepCoralFillsUnderInk(readFileSync(filePath, 'utf8')).map((line) => `${relativePath}:${line}`);
    });

    expect(offenders).toEqual([]);
  });
});
