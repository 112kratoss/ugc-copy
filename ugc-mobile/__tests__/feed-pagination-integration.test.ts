import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('feed pagination integration', () => {
  it.each([
    ['Home', 'components/home-dashboard.tsx'],
    ['Explore', 'app/(tabs)/showcase.tsx'],
    ['creator profile', 'components/creator-profile-screen.tsx'],
  ])('%s uses the shared page gate and visible load-more retry', (_surface, path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('nextFeedPageRequestDelay');
    // Two screens of runway let a page land inside the cooldown with the list
    // still near its end, and FlashList does not ask again: the screen does.
    expect(source).toContain('useAskAgainAfterCooldown');
    expect(source).toContain('onEndReachedThreshold={FEED_NEXT_PAGE_RUNWAY_SCREENS}');
    expect(source).toContain('lastLoadMorePageCountRef');
    expect(source).toContain('isFetchNextPageError');
    expect(source).toContain('<FeedLoadMoreErrorFooter');
    expect(source).not.toContain('lastLoadMoreItemCountRef');
  });
});
