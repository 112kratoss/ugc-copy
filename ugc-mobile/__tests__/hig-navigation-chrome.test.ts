import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatBadgeCount, MAX_BADGE_COUNT } from '../lib/notification-badge';
import { appTheme, themes } from '../lib/theme';

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

  /**
   * A pushed screen's header already names it, so the words over its page say
   * something else or nothing: "Settings" over "Account settings." under a
   * Settings header said the screen's name twice (redundant-ui audit, 2026-10-21).
   *
   * Titles are read as the sweep above reads them, from the root layout's list and
   * from screens that set their own, and a layout entry is read across lines. A
   * route that only renders a component is read through the components it imports,
   * where its page is drawn. On a page, the eyebrow is read in every form one is
   * written (a string, the strings of an expression, a bare Kicker), and so is the
   * heading: a heading drawn from data is read for the words written into its
   * expression, or the declaration of the name it is given, since those are what
   * the page shows while the data loads and after it fails to ("Recipe" under the
   * Your Recipe header until the recipe was in, the same audit's follow-up).
   *
   * An eyebrow repeats the title when it is the title's words. A heading names the
   * page, so it repeats the title when it says nothing the title does not: every
   * word of it is one of the title's, and "Recipe" repeats "Your Recipe". An eyebrow
   * names the group a page is in, which can be one of the title's words ("Account"
   * over Delete Account).
   */
  describe('never repeats a view title over its page', () => {
    type PageWords = { kind: 'eyebrow' | 'heading'; text: string };
    const stringsIn = (expression: string) => [...expression.matchAll(/'([^'\\]+)'|"([^"\\]+)"|`([^`$\\]+)`/g)]
      .map((string) => string[1] ?? string[2] ?? string[3]);
    const pageWords = (source: string): PageWords[] => [
      ...[...source.matchAll(/\beyebrow="([^"]+)"/g)].map((match) => match[1]),
      ...[...source.matchAll(/\beyebrow=\{([^}]*)\}/g)].flatMap((match) => stringsIn(match[1])),
      ...[...source.matchAll(/<Kicker\b[^>]*>([^<{]+)<\/Kicker>/g)].map((match) => match[1].trim()),
    ].map((text): PageWords => ({ kind: 'eyebrow', text })).concat(
      [...source.matchAll(/<(?:SectionTitle|SectionHeader)\b[^>]*?\btitle="([^"]+)"/g)].map((match) => ({ kind: 'heading', text: match[1] })),
      [...source.matchAll(/<(?:SectionTitle|SectionHeader)\b[^>]*?\btitle=\{([^}]*)\}/g)].flatMap((match) => {
        const expression = match[1].trim();
        const declared = /^[A-Za-z_$][\w$]*$/.test(expression)
          ? new RegExp(`\\bconst ${expression.replace(/\$/g, '\\$')} = ([^;]+);`).exec(source)?.[1] ?? ''
          : expression;
        return stringsIn(declared).map((text): PageWords => ({ kind: 'heading', text }));
      }),
    );
    const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const repeatsTitle = ({ kind, text }: PageWords, title: string) => (kind === 'eyebrow'
      ? words(text).join('') === words(title).join('')
      : words(text).length > 0 && words(text).every((word) => words(title).includes(word)));

    // Every entry of the root layout, however it is wrapped; one with no header shows no title to repeat.
    const layoutEntries = [...rootLayout.matchAll(/<Stack\.Screen\b([\s\S]*?)\/>/g)].flatMap((match) => {
      const name = /\bname="([^"]+)"/.exec(match[1])?.[1];
      const title = /\btitle: '([^']+)'/.exec(match[1])?.[1];
      return name && title ? [{ name, title, headerShown: !/headerShown: false/.test(match[1]) }] : [];
    });
    const routeFile = (name: string) => [`app/${name}.tsx`, `app/${name}/index.tsx`]
      .map((candidate) => path.join(mobileRoot, candidate))
      .find((candidate) => files.includes(candidate));
    // The route's own file and the components it imports, leaving out the primitives every page imports.
    const drawnIn = (file: string) => [file, ...[...readFileSync(file, 'utf8').matchAll(/from '@\/components\/([^']+)'/g)]
      .filter((match) => match[1] !== 'ui')
      .map((match) => path.join(mobileRoot, 'components', `${match[1]}.tsx`))
      .filter((candidate) => files.includes(candidate))];
    const pages = [
      ...layoutEntries.filter((entry) => entry.headerShown).flatMap(({ name, title }) => {
        const file = routeFile(name);
        return file ? [{ title, files: drawnIn(file) }] : [];
      }),
      ...titled.filter((entry) => entry.file !== 'app/_layout.tsx')
        .map(({ file, title }) => ({ title, files: [path.join(mobileRoot, file)] })),
    ];
    const read = pages.flatMap(({ title, files: drawn }) => drawn.flatMap((file) => (
      pageWords(readFileSync(file, 'utf8')).map((words) => ({ ...words, title, file: relative(file) }))
    )));
    const repeats = [...new Set(read
      .filter((entry) => repeatsTitle(entry, entry.title))
      .map(({ kind, text, title, file }) => `${file}: ${kind} "${text}" under the "${title}" header`))];

    it('reads every form of eyebrow and heading', () => {
      expect(pageWords([
        '<SectionTitle eyebrow="Settings" title="Settings." />',
        "<SectionHeader eyebrow={user ? 'Your recipes' : `Recipes`} title={detail.title} />",
        '<Kicker color="commerce">Help & Support</Kicker>',
        '<Kicker>{count} templates</Kicker>',
        "<SectionTitle eyebrow=\"Recipe details\" title={detail?.title ?? 'Recipe'} />",
        "const activeTitle = revision?.title ?? detail?.title ?? 'Your recipe';",
        '<SectionTitle',
        '  title={activeTitle}',
        '/>',
        '<SectionTitle title={`${count} recipes`} />',
      ].join('\n'))).toEqual([
        { kind: 'eyebrow', text: 'Settings' },
        { kind: 'eyebrow', text: 'Recipe details' },
        { kind: 'eyebrow', text: 'Your recipes' },
        { kind: 'eyebrow', text: 'Recipes' },
        { kind: 'eyebrow', text: 'Help & Support' },
        { kind: 'heading', text: 'Settings.' },
        { kind: 'heading', text: 'Recipe' },
        { kind: 'heading', text: 'Your recipe' },
      ]);
      const eyebrow = (text: string): PageWords => ({ kind: 'eyebrow', text });
      const heading = (text: string): PageWords => ({ kind: 'heading', text });
      expect(repeatsTitle(eyebrow('Your recipe'), 'Your Recipe')).toBe(true);
      expect(repeatsTitle(eyebrow('Signin'), 'Sign In')).toBe(true);
      expect(repeatsTitle(eyebrow('Help & Support'), 'Help and Support')).toBe(false);
      expect(repeatsTitle(eyebrow('Account'), 'Delete Account')).toBe(false);
      expect(repeatsTitle(heading('Your recipe.'), 'Your Recipe')).toBe(true);
      expect(repeatsTitle(heading('Recipe'), 'Your Recipe')).toBe(true);
      expect(repeatsTitle(heading('Recipe details'), 'Recipe')).toBe(false);
      expect(repeatsTitle(heading('Account settings.'), 'Settings')).toBe(false);
    });

    it('reads every titled screen, and the pages they draw', () => {
      // The layout's titles as the sweep above reads them, so an entry wrapped across lines is still one.
      expect(layoutEntries.map((entry) => entry.title)).toEqual(titled.filter((entry) => entry.file === 'app/_layout.tsx').map((entry) => entry.title));
      expect(layoutEntries.filter((entry) => !routeFile(entry.name)).map((entry) => entry.name)).toEqual([]);
      // Templates and a creator's page are drawn in components the route renders.
      expect(read.filter((words) => words.file === 'components/media-template-screens.tsx').length).toBeGreaterThan(0);
      expect(read.filter((words) => words.kind === 'eyebrow').length).toBeGreaterThan(9);
      // And the written page headings, so the check below is not passing on an empty read.
      expect(read.filter((words) => words.kind === 'heading').length).toBeGreaterThan(5);
    });

    // AI Data Sharing and Blocked Users were the last two, by the owner's call on A8 (2026-10-21):
    // a page heading says the page in words of its own, as Settings' "Account settings." does.
    it('never repeats a view title in an eyebrow or a page heading, loading or failed', () => {
      expect(repeats).toEqual([]);
    });
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
    expect(visibleTabs).toEqual(['Home', 'Explore', 'Alerts', 'Profile']);
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
    expect(tabBar).toContain('theme.colors.badge');
    expect(tabBar).toContain('theme.colors.onBadge');
    // The system's red with white in both schemes: a badge only reads as a
    // badge in the platform colour, on paper as on black.
    for (const scheme of ['dark', 'light'] as const) {
      expect(themes[scheme].colors.badge.toLowerCase()).toBe('#ff3b30');
      expect(themes[scheme].colors.onBadge.toLowerCase()).toBe('#ffffff');
    }
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
