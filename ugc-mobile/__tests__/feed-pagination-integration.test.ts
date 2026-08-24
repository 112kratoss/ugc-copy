import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('feed pagination integration', () => {
  it.each([
    ['Home', 'components/home-dashboard.tsx'],
    ['creator profile', 'components/creator-profile-screen.tsx'],
  ])('%s uses the shared page gate and visible load-more retry', (_surface, path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('canRequestNextFeedPage');
    expect(source).toContain('lastLoadMorePageCountRef');
    expect(source).toContain('isFetchNextPageError');
    expect(source).toContain('<FeedLoadMoreErrorFooter');
    expect(source).not.toContain('lastLoadMoreItemCountRef');
  });
});
