import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('feed pagination integration', () => {
  it.each([
    ['Home', 'components/home-dashboard.tsx', 'HOME_LANE_NEXT_PAGE_RUNWAY_SCREENS'],
    ['Explore', 'app/(tabs)/showcase.tsx', 'EXPLORE_NEXT_PAGE_RUNWAY_SCREENS'],
    ['creator profile', 'components/creator-profile-screen.tsx', 'FEED_NEXT_PAGE_RUNWAY_SCREENS'],
  ])('%s uses the shared page gate and visible load-more retry', (_surface, path, runway) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('nextFeedPageRequestDelay');
    // A page can land inside the cooldown with the list still within its runway,
    // and FlashList does not ask again: the screen does.
    expect(source).toContain('useAskAgainAfterCooldown');
    expect(source).toContain(`onEndReachedThreshold={${runway}}`);
    expect(source).toContain('lastLoadMorePageCountRef');
    expect(source).toContain('isFetchNextPageError');
    expect(source).toContain('<FeedLoadMoreErrorFooter');
    expect(source).not.toContain('lastLoadMoreItemCountRef');
  });
});
