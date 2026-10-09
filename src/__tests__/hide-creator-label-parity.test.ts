import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hideCreatorLabel as appLabel } from '../../ugc-mobile/lib/hide-creator-label';
import { hideCreatorLabel as webLabel } from '../lib/hide-creator-label';

// The row that hides a creator read four ways on 2026-10-09: "Hide Fluffy" on
// the web, "Hide fluffy" on the app's Home, "Hide @fluffy" on its Explore and
// "Hide this creator" in its reel. It is one wording now, worked out by one
// rule on each side of the repository. Web and app share no module, so this
// test is what keeps the two rules one.
describe('the Hide row, on the web and in the app', () => {
  const creators: Array<[{ username?: string | null; name?: string | null }, string]> = [
    [{ username: 'fluffy', name: 'Fluffy' }, 'Hide @fluffy'],
    [{ username: '@fluffy', name: 'Fluffy' }, 'Hide @fluffy'],
    [{ username: '  fluffy  ', name: null }, 'Hide @fluffy'],
    [{ username: null, name: 'Fluffy Cat' }, 'Hide Fluffy Cat'],
    [{ username: '', name: '  Fluffy Cat ' }, 'Hide Fluffy Cat'],
    [{ username: '   ', name: '   ' }, 'Hide this creator'],
    [{ username: null, name: null }, 'Hide this creator'],
    [{}, 'Hide this creator'],
  ];

  it.each(creators)('words %j the same on both', (creator, expected) => {
    expect(webLabel(creator)).toBe(expected);
    expect(appLabel(creator)).toBe(expected);
  });

  // The rule is only as good as its callers: each menu hands it the post's creator.
  it.each([
    'src/app/feed/FeedPostCard.tsx',
    'src/app/showcase/ShowcaseClient.tsx',
    'src/app/showcase/ShowcaseReelViewer.tsx',
  ])("gives the web menu in %s the post's creator", (file) => {
    expect(readFileSync(file, 'utf8')).toContain('creator={item.creator}');
  });

  it('is the only wording of that row in either menu', () => {
    const web = readFileSync('src/app/showcase/ShowcaseFeedInteraction.tsx', 'utf8');
    const appCard = readFileSync('ugc-mobile/lib/feed-feedback-menu.ts', 'utf8');
    const appSheet = readFileSync('ugc-mobile/components/feed-feedback-sheet.tsx', 'utf8');

    expect(web).toContain('label: hideCreatorLabel(creator),');
    expect(appCard).toContain('label: hideCreatorLabel(creator),');
    expect(appSheet).toContain('label={hideLabel}');
    // No row is labelled by a template of its own (a sentence may still begin with the word).
    for (const source of [web, appCard, appSheet]) expect(source).not.toMatch(/label[:=]\s*\{?`Hide \$\{/);
  });
});
