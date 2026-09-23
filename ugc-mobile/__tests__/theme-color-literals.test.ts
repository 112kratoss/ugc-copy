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
