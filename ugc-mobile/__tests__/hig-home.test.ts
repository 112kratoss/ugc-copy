import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * S4's rules, in the form a suite can hold. Sources: Toolbars, Branding,
 * Page controls, Scroll views, Motion.
 */

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

const dashboard = read('components/home-dashboard.tsx');
const shelfSource = read('components/home-shelf.tsx');
const authScreen = read('app/auth.tsx');

/** Slice one function out of a 1,400-line file rather than matching across it. */
function declaration(source: string, header: string) {
  const start = source.indexOf(header);
  expect(start, `missing ${header}`).toBeGreaterThan(-1);
  const next = source.indexOf('\nfunction ', start + header.length);
  return source.slice(start, next === -1 ? undefined : next);
}

const topBar = declaration(dashboard, 'function HomeTopBar(');
const shelf = declaration(shelfSource, 'export function HomeShelf(');
const startBlank = declaration(shelfSource, 'function StartBlankTile(');

describe('the home top bar', () => {
  /**
   * Toolbars: "Don't title windows with your app name. Your app's name doesn't
   * provide useful information about your content hierarchy or any window or
   * area in your app, so it doesn't work well as a title." Branding says the
   * same thing from the other side: "people seldom need to be reminded which
   * app they're using, and it's usually better to use the space to give people
   * valuable information and controls."
   */
  it('does not title the view with the app name', () => {
    expect(topBar).not.toContain('Magicbooklet');
  });

  /**
   * The brand still opens the app. Branding endorses exactly that placement —
   * "you might consider displaying a welcome or onboarding screen that
   * incorporates your branding content at the beginning of your experience".
   */
  it('keeps the wordmark where the chapter endorses it', () => {
    // S3 gave the four surfaces that drew this lockup by hand — at four sizes —
    // one `BrandLockup`, so the assertion moved from auth's own markup to the
    // control it mounts. The name itself is asserted in hig-onboarding.
    expect(authScreen).toContain('<BrandLockup />');
  });
});

describe('the Make this shelf', () => {
  /**
   * Motion: "Make motion optional", and "let people cancel motion". The rail
   * this replaced turned itself every 4.6 s; the shelf holds still, so nothing
   * on Home moves unless the person moves it.
   */
  it('holds still until the person moves it', () => {
    expect(shelfSource).not.toContain('setInterval');
    expect(shelfSource).not.toContain('setTimeout');
  });

  /**
   * Scroll views: a page control belongs to a scroll view "in page-by-page
   * mode". The shelf is not: two cards and a sliver of the third are on screen
   * at once, and the sliver is what says it scrolls. So no dots, and no
   * indicator either, as App Store shelves do it.
   */
  it('peeks the next card instead of drawing a page control', () => {
    expect(shelf).toContain('snapToInterval={card.width + SHELF_GAP}');
    expect(shelf).toContain('showsHorizontalScrollIndicator={false}');
    expect(shelfSource).not.toContain('SlideDots');
  });

  it('names every card for a screen reader', () => {
    expect(shelfSource).toContain('accessibilityLabel={homeShelfCreationLabel(creation)}');
    expect(shelfSource).toContain('accessibilityLabel={`${copy.title}. ${copy.body}`}');
  });

  /** 44pt hit regions: the end tile's rows are drawn shorter and given the rest as slop. */
  it('keeps the end tile\'s rows at a full hit region', () => {
    expect(startBlank).toContain('hitSlop={verticalHitSlop(ROW_HEIGHT)}');
    expect(startBlank).toContain('minHeight: ROW_HEIGHT');
  });

  /**
   * The row sits in the feed's list header, and FlashList anchors on its
   * height: it keeps one height through loading, an empty answer (the tools in
   * the cards' place) and the renders line taking the subtitle's.
   */
  it('keeps one height whatever it is showing', () => {
    expect(shelf).not.toContain('return null');
    expect(shelf).toContain('HOME_SHELF_START_BLANK_TOOLS.map((tool) => (');
    expect(shelf).toContain("<View style={{ minHeight: 44, justifyContent: 'center' }}>");
    expect(declaration(shelfSource, 'function ActiveRendersLine(')).toContain('minHeight: 44,');
    expect(dashboard).toContain('isLoading={shelfQuery.isPending}');
    expect(dashboard).toContain('placeholderData: keepHomeShelfCreations,');
  });
});
