import { expect, test } from '@playwright/test';

// GET /api/search/starter through the real proxy and the real route: a visitor's answer is the one
// the edge may keep, so the proxy's CORS `Vary: Origin` and the route's `Vary: Authorization` must
// both reach it, or a kept visitor's answer could be served to a token holder (whose blocks and
// follows it would ignore). Its two database calls are answered by the server's Supabase stub
// (tests/e2e/support/supabase-server-stub.cjs, fixtures/search-starter.json).

test('keeps Vary: Authorization on a visitor’s cacheable starter beside the proxy’s CORS headers', async ({ page }) => {
  const origin = 'http://127.0.0.1:3100';
  const response = await page.request.get('/api/search/starter', { headers: { Origin: origin }, timeout: 0 });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    entities: [{ kind: 'tool', key: 'e2e-tool', label: 'E2E Tool', postCount: 2, postCountCapped: false, query: 'e2e tool' }],
    creators: [{
      id: 'workflow-user',
      username: 'e2e-creator',
      displayName: 'E2E Creator',
      bio: null,
      avatarUrl: null,
      publicPostCount: 2,
      isFollowing: false,
    }],
    searches: [{ text: 'portrait' }],
  });
  const headers = response.headers();
  expect(headers['cache-control']).toBe('public, s-maxage=60, stale-while-revalidate=300');
  // The proxy answered this path as one of the app's: its CORS grant is on the response.
  expect(headers['access-control-allow-origin']).toBe(origin);
  const vary = (headers.vary ?? '').split(',').map((name) => name.trim().toLowerCase());
  expect(vary).toContain('authorization');
  expect(vary).toContain('origin');
});
