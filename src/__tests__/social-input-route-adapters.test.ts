import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { postProfileShareRouteResponse } from '@/lib/profile-share-route-adapter-service';
import { postShowcaseShareRouteResponse } from '@/lib/showcase-share-route-adapter-service';
import { postShowcasePublishRouteResponse } from '@/lib/showcase-publish-route-adapter-service';
import { postShowcaseRemixRouteResponse } from '@/lib/showcase-remix-route-adapter-service';
import { postShowcaseSaveRouteResponse } from '@/lib/showcase-save-route-adapter-service';
import { postReportRouteResponse } from '@/lib/post-report-route-adapter-service';
import { postPostsRouteResponse } from '@/lib/posts-route-adapter-service';

const routes = [
  { operation: 'shareCreatorProfile', path: '/api/profile/share', handler: postProfileShareRouteResponse, error: 'Missing creator username' },
  { operation: 'shareShowcasePost', path: '/api/showcase/share', handler: postShowcaseShareRouteResponse, error: 'Missing post ID' },
  { operation: 'publishGeneration', path: '/api/showcase/publish', handler: postShowcasePublishRouteResponse, error: 'Missing generation ID' },
  { operation: 'remixShowcasePost', path: '/api/showcase/remix', handler: postShowcaseRemixRouteResponse, error: 'Missing post ID' },
  { operation: 'saveShowcasePost', path: '/api/showcase/save', handler: postShowcaseSaveRouteResponse, error: 'Missing post ID' },
  { operation: 'reportPost', path: '/api/posts/post-1/report', handler: (args: Parameters<typeof postReportRouteResponse>[0]) => postReportRouteResponse({ ...args, postId: 'post-1' }), error: 'Choose a valid report reason.' },
  { operation: 'createPost', path: '/api/posts', handler: postPostsRouteResponse, error: 'Invalid post form data.' },
];

describe('social input errors at HTTP adapters', () => {
  it.each(routes.flatMap(route => ['{', 'null'].map(body => ({ ...route, body }))))('$path rejects $body before data work', async ({ handler, path, operation, body }) => {
    const from = vi.fn(() => { throw Error('Malformed input must not read or mutate tables'); });
    const rpc = vi.fn(async (name: string) => {
      expect(name).toBe('check_backend_rate_limit');
      return { data: { allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0, resetAt: '2026-10-05T01:00:00Z' }, error: null };
    });
    const admin = { from, rpc } as unknown as SupabaseClient;
    const user = { auth: { getUser: async () => ({ data: { user: { id: 'user-1', is_anonymous: false } }, error: null }) } } as unknown as SupabaseClient;
    const response = await handler({
      postId: 'post-1',
      request: new Request('http://localhost' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
      dependencies: { createUserClient: () => user, createServiceClient: () => admin, logError: vi.fn() },
    });
    const contract = mobileApiContract.socialInputErrors.find(item => item.operation === operation)!;
    expect(response.status).toBe(contract.status);
    await expect(response.json()).resolves.toEqual(contract.response);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(from).not.toHaveBeenCalled();
  });
});
