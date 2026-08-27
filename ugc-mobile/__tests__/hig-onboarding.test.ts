import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appTheme } from '../lib/theme';

const mobileRoot = path.resolve(__dirname, '..');

function read(relativePath: string) {
  return readFileSync(path.join(mobileRoot, relativePath), 'utf8');
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    if (statSync(absolutePath).isDirectory()) files.push(...sourceFiles(absolutePath));
    else if (/\.tsx?$/.test(entry)) files.push(absolutePath);
  }
  return files;
}

const ui = read('components/ui.tsx');
const header = read('components/onboarding-header.tsx');
const welcome = read('components/onboarding-welcome.tsx');
const booklet = read('components/onboarding-booklet.tsx');
const screen = read('app/onboarding.tsx');

describe('the product has one wordmark', () => {
  /**
   * Four surfaces drew this lockup by hand before S3 — the onboarding welcome
   * (a 29pt glyph beside 25pt/800 text), the onboarding goal header (26/23),
   * the home side menu (24 filled/20) and auth (20/19) — so the flow introduced
   * the app's name at three sizes in three taps. Design principles/Familiarity:
   * "once you establish a behavior or appearance for an element, apply it
   * throughout your design."
   */
  it('draws the name in exactly one component', () => {
    const offenders = sourceFiles(path.join(mobileRoot, 'app'))
      .concat(sourceFiles(path.join(mobileRoot, 'components')))
      .filter((filePath) => path.basename(filePath) !== 'ui.tsx')
      .filter((filePath) => /<Text[^>]*>\s*Magicbooklet\s*<\/Text>|>Magicbooklet<\/AppText>/.test(readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(mobileRoot, filePath));

    expect(offenders).toEqual([]);
  });

  it('is mounted by every surface that used to draw its own', () => {
    for (const source of [read('app/auth.tsx'), read('components/home-side-menu.tsx'), header]) {
      expect(source).toContain('BrandLockup');
    }
  });

  /**
   * Branding: the custom face carries display and title roles. The lockup is
   * the definitive one, and being a display variant it must not be re-weighted
   * (`hig-type-and-contrast.test.ts` enforces that tree-wide).
   */
  it('takes the display face from the ramp at both sizes', () => {
    expect(ui).toContain("variant={hero ? 'pageTitle' : 'sectionTitle'}");
    expect(ui).toContain('size={hero ? appTheme.icon.hero : appTheme.icon.feature}');
    expect(appTheme.type.pageTitle).toHaveProperty('fontFamily');
    expect(appTheme.type.sectionTitle).toHaveProperty('fontFamily');
  });
});

describe('the onboarding flow stays optional', () => {
  /**
   * Onboarding: "if onboarding is necessary, design a flow that's fast, fun,
   * and optional." The escape used to appear only on the second screen.
   */
  it('offers the same escape on both intro steps, from one control', () => {
    expect(header).toContain("accessibilityLabel=\"Skip onboarding and explore as guest\"");
    expect(welcome).toContain('<OnboardingHeader size="hero" onSkip={onSkip} />');
    expect(screen).toContain('onSkip={() => void exploreAsGuest()}');
    expect(screen).toContain("onSkip={stage === 'intro' ? () => void exploreAsGuest() : undefined}");
  });

  it('does not offer a second control for the same action', () => {
    // The goal screen carried "Explore as guest" in its footer *and* "Skip" in
    // its header, both calling the same function under two names.
    expect(booklet).not.toContain('Explore as guest');
    expect(booklet).not.toContain('onExploreAsGuest');
    expect(screen).not.toContain('onExploreAsGuest');
  });

  /**
   * The failure branch had no way out at all: the header only offers Skip
   * during `intro`, and the route sets `gestureEnabled: false`.
   */
  it('leaves a way out when the setup call fails', () => {
    expect(screen).toContain('<SecondaryButton label="Skip for now"');
    expect(screen).toContain("leaveForNow('loading')");
  });

  it('says what went wrong in the app\'s words, not the API\'s', () => {
    expect(screen).not.toContain("error.message : 'Could not continue onboarding.'");
    expect(screen).toContain('We could not load your creator setup');
    expect(screen).toContain('isNetworkRequestFailedError(error)');
  });
});

describe('the screens that introduce the product use its typeface', () => {
  /**
   * Both headlines were hand-set sizes at weight 900 with no variant, which
   * means the *system* font — the face Branding reserves for body copy — on the
   * two screens a new install sees first.
   */
  it('titles both intro steps with the type ramp', () => {
    expect(welcome).toContain('<AppText heading variant="pageTitle" selectable>');
    expect(booklet).toContain('<AppText heading variant="pageTitle">');
  });

  it('leaves no hand-rolled heavy type in the flow', () => {
    for (const source of [welcome, booklet, header]) {
      expect(source).not.toMatch(/fontWeight: '(800|900)'/);
      expect(source).not.toMatch(/fontSize: (2[0-9]|3[0-9])/);
    }
  });
});
