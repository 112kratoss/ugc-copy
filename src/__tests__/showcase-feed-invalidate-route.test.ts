import fs from 'node:fs';
import path from 'node:path';

import { revalidateTag } from 'next/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SHOWCASE_FEED_INVALIDATE_PATH } from '../../scripts/ops/moderation-ops';
import { routeIdentityPolicy } from '@/lib/route-identity-policy';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';
import {
  getShowcaseFeedInvalidateRouteResponse,
  SHOWCASE_FEED_INVALIDATE_ROUTE,
} from '@/lib/showcase-feed-invalidate-route-adapter-service';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }));

function request(authorization?: string) {
  return new Request(`http://localhost${SHOWCASE_FEED_INVALIDATE_ROUTE}`, {
    headers: {
      'x-request-id': 'feed-invalidate-1',
      ...(authorization ? { authorization } : {}),
    },
  });
}

async function callRoute(authorization?: string) {
  const { GET } = await import('@/app/api/cron/showcase-feed-invalidate/route');
  return GET(request(authorization));
}

describe('/api/cron/showcase-feed-invalidate', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'secret-123');
    vi.stubEnv('CRON_SECRET_PREVIOUS', '');
    vi.mocked(revalidateTag).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refreshes the feed tag for a caller with the cron secret', async () => {
    const response = await callRoute('Bearer secret-123');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('feed-invalidate-1');
    await expect(response.json()).resolves.toEqual({ success: true, invalidated: [SHOWCASE_FEED_CACHE_TAG] });
    // What every publish, edit and take-down in the app calls.
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith(SHOWCASE_FEED_CACHE_TAG, { expire: 0 });
  });

  it.each([
    ['no token', undefined],
    ['a wrong secret', 'Bearer not-the-secret'],
    ['the secret without its scheme', 'secret-123'],
  ])('refuses %s, refreshing nothing', async (_case, authorization) => {
    const response = await callRoute(authorization);

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('takes the previous secret during a rotation, and fails closed with none set', async () => {
    vi.stubEnv('CRON_SECRET', 'secret-new');
    vi.stubEnv('CRON_SECRET_PREVIOUS', 'secret-123');
    expect((await callRoute('Bearer secret-123')).status).toBe(200);

    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('CRON_SECRET_PREVIOUS', '');
    expect((await callRoute('Bearer ')).status).toBe(401);
    expect(revalidateTag).toHaveBeenCalledTimes(1);
  });

  it('answers 500 when the refresh itself fails', async () => {
    const logEvent = vi.fn();

    const response = await getShowcaseFeedInvalidateRouteResponse({
      request: request('Bearer secret-123'),
      dependencies: {
        isAuthorizedCronRequest: () => true,
        invalidateShowcaseFeedCache: () => { throw new Error('incremental cache unavailable'); },
        logEvent,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(logEvent).toHaveBeenCalledWith('error', 'showcase_feed_cache_invalidation_failed', expect.objectContaining({
      route: SHOWCASE_FEED_INVALIDATE_ROUTE,
    }));
  });

  it('is a service route outside bearer admission, at the path the moderation CLI calls', () => {
    expect(routeIdentityPolicy(SHOWCASE_FEED_INVALIDATE_ROUTE)).toBe('service');
    expect(SHOWCASE_FEED_INVALIDATE_PATH).toBe(SHOWCASE_FEED_INVALIDATE_ROUTE);
    const routeSource = fs.readFileSync(
      path.resolve(process.cwd(), `src/app${SHOWCASE_FEED_INVALIDATE_ROUTE}/route.ts`),
      'utf8',
    );
    // GET, like the other manual cron triggers; nothing schedules it.
    expect(routeSource).toContain('export const { GET }');
    expect(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8')).crons)
      .not.toContainEqual(expect.objectContaining({ path: SHOWCASE_FEED_INVALIDATE_ROUTE }));
  });
});
