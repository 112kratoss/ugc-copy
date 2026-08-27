import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appTheme } from '../lib/theme';
import { DEFAULT_PROFILE_MEDIA_TAB, PROFILE_MEDIA_TABS, getProfileStats } from '../lib/profile-view-model';

/**
 * S13/S14's rules, in the form a suite can hold. Sources: Color, Segmented
 * controls, Typography, Layout, Feedback, Design principles.
 */

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

const dashboard = read('components/profile-dashboard.tsx');
const creator = read('components/creator-profile-screen.tsx');
const showcase = read('app/(tabs)/showcase.tsx');
const alerts = read('app/(tabs)/studio.tsx');

/** Slice one declaration out of a long file rather than matching across it. */
function declaration(source: string, header: string) {
  const start = source.indexOf(header);
  expect(start, `missing ${header}`).toBeGreaterThan(-1);
  const next = source.indexOf('\nfunction ', start + header.length);
  return source.slice(start, next === -1 ? undefined : next);
}

const profileTitle = declaration(dashboard, 'function ProfileTitle(');
const mediaHeader = declaration(dashboard, 'function ProfileMediaHeader(');
const minimalOverlay = declaration(dashboard, 'function ProfileMinimalMediaOverlay(');
const tile = declaration(dashboard, 'function ProfileMediaTile(');
const creatorHeader = declaration(creator, 'function CreatorHeader(');
const creatorAvatar = declaration(creator, 'function CreatorAvatar(');

describe('a profile tile reports its state in more than colour', () => {
  /**
   * Color: "Avoid relying solely on color to differentiate between objects,
   * indicate interactivity, or communicate essential information. When you use
   * color to convey information, be sure to provide the same information in
   * alternative ways ... you can use text labels or glyph shapes to identify
   * objects or states."
   *
   * The badge was a bare 10pt dot: green for a public post, amber for a private
   * one, and nothing else at all.
   */
  it('draws a glyph inside the state badge, not just a filled dot', () => {
    expect(minimalOverlay).toContain('profile-tile-state-badge');
    expect(minimalOverlay).toContain('<StateGlyph');
  });

  it('keeps the badge and the spoken label reading from one source', () => {
    expect(minimalOverlay).toContain('getProfileTileState(item)');
    expect(tile).toContain('getProfileTileState(item).label');
  });

  /**
   * The label used to stop at `Post, <title>` — the state its badge drew was
   * available to sighted users and to no one else.
   */
  it('never labels an owned tile without its state', () => {
    expect(tile).not.toContain('`${item.label}, ${item.title}`');
  });
});

describe('the media segmented control', () => {
  /**
   * Segmented controls: "A segmented control that displays text labels doesn't
   * need introductory text." The heading above it printed the selected tab —
   * "Creations" over a pill reading "Creations".
   */
  it('carries no heading that repeats the selected segment', () => {
    expect(mediaHeader).not.toContain('sectionTitle');
    expect(dashboard).not.toContain('getProfileMediaSectionTitle');
  });

  it('leaves the refresh control named after the tab it refreshes', () => {
    expect(mediaHeader).toContain('label={`Refresh ${activeTab}`}');
  });

  /**
   * Design principles' Consistency. The hero card prints the same three
   * collections directly above this control; they cannot be listed two ways.
   */
  it('lists the collections in the same order as the stats above it', () => {
    const statLabels = getProfileStats({
      generationsCount: 0,
      postsCount: 0,
      savedCount: 0,
    }).map((stat) => stat.label);

    expect(PROFILE_MEDIA_TABS).toEqual(statLabels);
  });

  /**
   * With the order corrected, a default of `Saved` would have opened the screen
   * on its last segment, showing media saved from other people on the reader's
   * own creator profile. The default follows the first segment.
   */
  it('opens on the first segment', () => {
    expect(DEFAULT_PROFILE_MEDIA_TAB).toBe(PROFILE_MEDIA_TABS[0]);
  });

  /** Segmented controls: "no more than about five segments on iPhone". */
  it('stays inside the segment count a phone can carry', () => {
    expect(PROFILE_MEDIA_TABS.length).toBeLessThanOrEqual(5);
  });
});

describe('the profile page title', () => {
  /**
   * The display face ships as a single weight, so every `type` variant that
   * uses it sets `fontWeight: '400'` — a heavier value makes Android
   * synthesize a bolder one. This title took `sectionTitle` and then overrode
   * the weight back to `'800'`, the only place in the tree that did.
   */
  it('does not re-bold the single-weight display face', () => {
    expect(profileTitle).not.toContain("fontWeight: '800'");
    expect(appTheme.type.pageTitle.fontWeight).toBe('400');
  });

  it('uses the page-title token rather than a hand-rolled size', () => {
    expect(profileTitle).toContain('variant="pageTitle"');
    expect(profileTitle).not.toContain('fontSize:');
  });

  /** The other two tab roots already announce their titles as headers. */
  it('announces itself as a header, the way its sibling tabs do', () => {
    expect(profileTitle).toContain('accessibilityRole="header"');
    expect(showcase).toContain('accessibilityRole="header"');
    expect(alerts).toContain('accessibilityRole="header"');
  });

  /**
   * Branding: "people seldom need to be reminded which app they're using, and
   * it's usually better to use the space to give people valuable information
   * and controls." The strapline described the card directly beneath it.
   */
  it('does not describe the screen to someone already looking at it', () => {
    expect(dashboard).not.toContain('Your identity, balance, and published work');
  });
});

describe('a creator profile leads with the creator, not with reporting them', () => {
  /**
   * Layout: "make essential information easy to find by giving it sufficient
   * space ... don't obscure it by crowding it with nonessential details. You
   * can make secondary information available in other parts of the window."
   *
   * Report and Block were two permanently mounted, danger-tinted, full-width
   * buttons in the header — louder than Share, and louder than the work.
   */
  it('keeps the safety actions out of the header', () => {
    expect(creatorHeader).not.toContain('SafetyAction');
    expect(creator).not.toContain('function SafetyAction');
  });

  /** They stay reachable, one tap deeper, through the sheet N2 built. */
  it('offers them from an overflow control instead', () => {
    expect(creatorHeader).toContain('label="More options"');
    expect(creator).toContain('showActionSheet({');
    expect(creator).toContain("label: 'Report user', destructive: true");
    expect(creator).toContain("label: 'Block user', destructive: true");
  });

  /** Only on someone else's profile — you cannot report yourself. */
  it('shows the overflow control to visitors only', () => {
    expect(creatorHeader).toContain('{!data.viewer.isOwner ? (');
  });

  /**
   * Design principles' Consistency: one account, one avatar shape. The profile
   * tab, every feed row and the comments sheet all draw it round.
   */
  it('draws the avatar round, like every other avatar in the app', () => {
    expect(creatorAvatar).toContain('borderRadius: size / 2');
    expect(creatorAvatar).not.toContain('borderRadius: 24');
  });
});

describe('a creator profile that cannot load', () => {
  /**
   * Feedback: "show people when a command can't be carried out and help them
   * understand why." The body used to print `error.message` — the API's words,
   * to someone who cannot act on them.
   */
  it('does not print the raw API error to the reader', () => {
    expect(creator).not.toContain('profileQuery.error instanceof Error ? profileQuery.error.message');
  });

  /** A missing creator is not retryable, so it offers a way on instead. */
  it('offers Showcase when the creator is gone and a retry when it is not', () => {
    expect(creator).toContain("label={notFound ? 'Browse Showcase' : 'Try again'}");
  });
});
