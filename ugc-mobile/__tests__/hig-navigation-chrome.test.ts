import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatBadgeCount, MAX_BADGE_COUNT } from '../lib/notification-badge';
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
const rootLayout = readFileSync(path.join(mobileRoot, 'app/_layout.tsx'), 'utf8');
const tabBar = readFileSync(path.join(mobileRoot, 'components/magic-tab-bar.tsx'), 'utf8');

function relative(absolutePath: string) {
  return path.relative(mobileRoot, absolutePath);
}

/**
 * N1 — the navigation chrome rules this app has adopted from Toolbars, Tab bars
 * and Status bars. Each one is a rule that only holds if it holds everywhere, so
 * each is checked by sweeping the tree rather than by testing one screen.
 */
describe('HIG toolbars — view titles', () => {
  /**
   * Titles are declared in two places: the root layout's `Stack.Screen` list,
   * and `<Stack.Screen options={{ title }} />` written inline by a screen that
   * wants to set its own. Sweeping only the layout misses the second kind
   * entirely — which is how a screen came to title itself with an unbounded
   * template name from the catalog.
   */
  const titled = files.flatMap((file) =>
    // Anchored on `options={{` so this reads navigation titles and not every
    // object in the tree that happens to carry a `title` prop.
    [...readFileSync(file, 'utf8').matchAll(/options=\{\{[^}]*?title: '([^']+)'/g)].map((match) => ({
      file: relative(file),
      title: match[1],
    }))
  );
  const titles = titled.map((entry) => entry.title);

  it('declares a title for every titled stack screen', () => {
    expect(titles.length).toBeGreaterThan(10);
  });

  /**
   * Toolbars caps a title at roughly 15 characters, which only means anything
   * if the string is knowable at build time. A title interpolated from a
   * template name, a username or a post body has no bound at all.
   */
  it('never binds a view title to unbounded content', () => {
    const dynamic = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/options=\{\{[^}]*?title:\s*([^'\s][^,}]*)/g)].map(
        (match) => `${relative(file)}: ${match[1].trim()}`
      )
    );
    expect(dynamic).toEqual([]);
  });

  /**
   * Toolbars: "Write a concise title. Aim for a word or short phrase that
   * distills the purpose of the window or view, and keep the title under 15
   * characters long so you leave enough room for other controls."
   */
  it.each([[15]])('keeps every title under %i characters', (limit) => {
    const tooLong = titled.filter((entry) => entry.title.length > limit);
    expect(tooLong).toEqual([]);
  });

  /**
   * Toolbars: "Don't title windows with your app name. Your app's name doesn't
   * provide useful information about your content hierarchy."
   */
  it('never titles a view with the product name', () => {
    const branded = titled.filter((entry) => /magic\s*booklet/i.test(entry.title));
    expect(branded).toEqual([]);
  });

  /**
   * Design principles / Familiarity: "Once you establish a behavior or
   * appearance for an element, apply it throughout your design." The app's
   * native headers settled on title case; a sentence-case title one push away
   * reads as a different app. Short connecting words stay lowercase, as they do
   * in the system's own titles.
   */
  it('uses one capitalisation convention across every title', () => {
    const minorWords = new Set(['a', 'an', 'and', 'the', 'to', 'of', 'or', 'for', 'in', 'on']);
    const offenders = titled.filter(({ title }) =>
      title.split(' ').some((word, index) => {
        const bare = word.replace(/[^A-Za-z]/g, '');
        if (!bare) return false;
        if (index > 0 && minorWords.has(bare.toLowerCase())) return false;
        return bare[0] !== bare[0].toUpperCase();
      })
    );
    expect(offenders).toEqual([]);
  });
});

describe('HIG toolbars — the Back control', () => {
  /**
   * Toolbars: "Use the standard Back and Close buttons ... If you create a
   * custom version of either, make sure it still looks the same, behaves as
   * people expect, and matches the rest of your interface, and ensure you
   * consistently implement it throughout your app."
   *
   * The app draws its own header on some screens and lets the navigator draw it
   * on others, so both are on screen in the same session. `BackGlyph` resolves
   * to each platform's standard shape; a raw arrow or chevron rendered as a
   * back control would contradict the header one screen away.
   */
  it('routes every back control through BackGlyph', () => {
    const offenders = files
      .filter((file) => relative(file) !== 'lib/platform-glyphs.ts')
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        // `<ChevronLeft` also paginates the media lightbox, where it means
        // "previous item", not "back" — a different meaning, so it stays.
        const isPagingControl = relative(file) === 'components/media-lightbox.tsx';
        const hits: string[] = [];
        if (/<ArrowLeft[\s/>]/.test(source)) hits.push(`${relative(file)}: <ArrowLeft`);
        if (!isPagingControl && /<ChevronLeft[\s/>]/.test(source)) hits.push(`${relative(file)}: <ChevronLeft`);
        return hits;
      });

    expect(offenders).toEqual([]);
  });

  it('draws every back control at one size from the icon ramp', () => {
    const sizes = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/<BackGlyph\s+size=\{([^}]+)\}/g)].map((match) => ({
        file: relative(file),
        size: match[1].trim(),
      }))
    );

    expect(sizes.length).toBeGreaterThan(0);
    const offRamp = sizes.filter((entry) => entry.size !== 'appTheme.icon.feature');
    expect(offRamp).toEqual([]);
  });

  /**
   * The native stack header has to agree with the custom ones. `minimal` is the
   * chevron with no text beside it — Toolbars: "don't use a text label that
   * says Back or Close".
   */
  it('keeps the native header back button label-free', () => {
    expect(rootLayout).toContain("headerBackButtonDisplayMode: 'minimal'");
  });
});

describe('HIG tab bars', () => {
  const visibleTabs = [...tabBar.matchAll(/\{ route: '[^']+', label: '([^']+)', Icon: \w+ \}/g)].map(
    (match) => match[1]
  );

  it('names every visible tab', () => {
    expect(visibleTabs).toEqual(['Home', 'Showcase', 'Alerts', 'Profile']);
  });

  /** Tab bars: "Use single words whenever possible." */
  it('labels tabs with single words', () => {
    expect(visibleTabs.filter((label) => label.includes(' '))).toEqual([]);
  });

  /**
   * Tab bars: "Avoid overflow tabs ... the trailing tab becomes a More tab."
   * Four tabs plus the raised create control fit at every supported width, so
   * the More tab can never appear; this fails if a fifth is ever added.
   */
  it('stays below the width that would force a More tab', () => {
    expect(visibleTabs.length).toBeLessThanOrEqual(4);
    expect(tabBar).not.toMatch(/label: 'More'/);
  });

  /**
   * Tab bars: "Don't disable or hide tab bar buttons, even when their content
   * is unavailable." Every tab renders unconditionally; only the bar as a whole
   * hides, and only on the create surface (a divergence with its own ledger
   * row), never an individual button.
   */
  it('never disables an individual tab button', () => {
    expect(tabBar).not.toMatch(/<TabButton[^>]*disabled/);
  });

  /**
   * Tab bars: "a badge — a red oval containing white text and either a number
   * or an exclamation point."
   */
  it('draws the badge in the platform red with white text', () => {
    expect(tabBar).toContain('appTheme.colors.badge');
    expect(tabBar).toContain('appTheme.colors.onBadge');
    expect(appTheme.colors.badge.toLowerCase()).toBe('#ff3b30');
    expect(appTheme.colors.onBadge.toLowerCase()).toBe('#ffffff');
  });

  it('badges only the tab that has something to announce', () => {
    const badged = [...tabBar.matchAll(/<TabButton[^>]*badge=\{(\w+)\}/g)];
    expect(badged).toHaveLength(1);
  });
});

describe('notification badge formatting', () => {
  it('draws nothing when there is nothing unread', () => {
    expect(formatBadgeCount(0)).toBeNull();
    expect(formatBadgeCount(undefined)).toBeNull();
    expect(formatBadgeCount(null)).toBeNull();
    expect(formatBadgeCount(-3)).toBeNull();
    expect(formatBadgeCount(Number.NaN)).toBeNull();
  });

  it('prints a plain count up to the cap', () => {
    expect(formatBadgeCount(1)).toBe('1');
    expect(formatBadgeCount(12)).toBe('12');
    expect(formatBadgeCount(MAX_BADGE_COUNT)).toBe('99');
  });

  it('caps rather than widening the oval', () => {
    expect(formatBadgeCount(MAX_BADGE_COUNT + 1)).toBe('99+');
    expect(formatBadgeCount(4321)).toBe('99+');
  });
});

describe('HIG status bars', () => {
  /**
   * Status bars: "Obscure content under the status bar ... Prefer using a
   * scroll edge effect to place a blurred view behind the status bar." The
   * native stack header supplies that effect on pushed screens; the four tab
   * screens scroll their own content to the top of the window, so each renders
   * `TopScrim` to keep the clock off the artwork.
   */
  it('keeps a scrim behind the status bar on every full-bleed tab screen', () => {
    const fullBleedTabScreens = [
      'components/home-dashboard.tsx',
      'app/(tabs)/showcase.tsx',
      'app/(tabs)/studio.tsx',
      'components/profile-dashboard.tsx',
    ];

    for (const file of fullBleedTabScreens) {
      const source = readFileSync(path.join(mobileRoot, file), 'utf8');
      expect(source, `${file} scrolls under the status bar without a TopScrim`).toContain('<TopScrim');
    }
  });

  /** Status bars: "Avoid permanently hiding the status bar." */
  it('never hides the status bar', () => {
    const offenders = files.filter((file) => /<StatusBar[^>]*\bhidden\b/.test(readFileSync(file, 'utf8')));
    expect(offenders.map(relative)).toEqual([]);
  });
});

/**
 * N3 — the side menu and the shell's motion. Sidebars, Motion.
 */
describe('HIG sidebars — the workspace menu', () => {
  const gestureLayer = readFileSync(
    path.join(mobileRoot, 'components/workspace-side-menu-gesture-layer.tsx'),
    'utf8'
  );

  it('never lets the edge swipe be the only way in', () => {
    // Gestures: "Use shortcut gestures to supplement standard gestures, not
    // replace them ... people also need simple, familiar ways to navigate and
    // perform actions, even if it means an extra tap or two." Sidebars:
    // "Avoid hiding the sidebar by default to ensure that it remains
    // discoverable." Showcase mounted the layer and offered no control at all.
    const hosts = files
      .filter((file) => relative(file) !== 'components/workspace-side-menu-gesture-layer.tsx')
      .filter((file) => readFileSync(file, 'utf8').includes('<WorkspaceSideMenuGestureLayer'));

    expect(hosts.map(relative)).not.toEqual([]);

    const withoutControl = hosts
      .filter((file) => !readFileSync(file, 'utf8').includes('useWorkspaceSideMenu'))
      .map(relative);

    expect(withoutControl).toEqual([]);
  });

  it('opens the menu with one glyph and one label everywhere', () => {
    // Two screens now offer the same menu; a hamburger on one and something
    // else on the other is the Familiarity problem in miniature.
    const openers = files
      .filter((file) => relative(file) !== 'components/workspace-side-menu-gesture-layer.tsx')
      .filter((file) => readFileSync(file, 'utf8').includes('WORKSPACE_SIDE_MENU_LABEL'))
      .map(relative);

    expect(openers.sort()).toEqual([
      'app/(tabs)/showcase.tsx',
      'components/home-dashboard.tsx',
    ]);

    const rogue = openers.filter((name) => (
      !readFileSync(path.join(mobileRoot, name), 'utf8').includes('WorkspaceSideMenuGlyph')
    ));
    expect(rogue).toEqual([]);
  });

  it('closes the drawer with the gesture that opened it', () => {
    // Motion: "if someone reveals a view by sliding it down from the top, they
    // don't expect to dismiss the view by sliding it to the side." The drawer
    // is revealed by dragging in from the left edge, so it closes by dragging
    // back to it — on the same distance and velocity a sheet uses.
    const drawer = readFileSync(path.join(mobileRoot, 'components/home-side-menu.tsx'), 'utf8');

    expect(drawer).toContain('onMoveShouldSetPanResponderCapture');
    expect(drawer).toContain('SHEET_DISMISS_DISTANCE');
    expect(drawer).toContain('SHEET_DISMISS_VELOCITY');
    // Opened from the left edge, so only a leftward drag may close it.
    expect(drawer).toMatch(/gesture\.dx < -DRAWER_DRAG_CLAIM_DISTANCE/);
  });

  it('keeps the drawer one level deep', () => {
    // Sidebars: "In general, show no more than two levels of hierarchy in a
    // sidebar." Every row navigates; none of them expands in place.
    const drawer = readFileSync(path.join(mobileRoot, 'components/home-side-menu.tsx'), 'utf8');

    expect(drawer).not.toContain('DisclosureSection');
    expect(gestureLayer).not.toContain('DisclosureSection');
  });
});

describe('HIG motion — the shell', () => {
  it('routes every shell transition through the Reduce Motion preference', () => {
    // Motion: "Make motion optional. Not everyone can or wants to experience
    // the motion in your app." A screen that names an animation without asking
    // is a transition that plays regardless of the setting.
    const layouts = ['app/_layout.tsx', 'app/(tabs)/_layout.tsx'];
    const unguarded = layouts.flatMap((name) => {
      const source = readFileSync(path.join(mobileRoot, name), 'utf8');
      return [...source.matchAll(/animation: ([^,\n]+)/g)]
        // The value runs to the comma or the end of the options object, so trim
        // the closing braces a single-line `options={{ … }}` leaves behind.
        .map((match) => match[1].replace(/[}/>\s]+$/, '').trim())
        .filter((value) => !value.startsWith('reducedMotion ?') && value !== "'none'")
        .map((value) => `${name}: ${value}`);
    });

    expect(unguarded).toEqual([]);
  });
});
