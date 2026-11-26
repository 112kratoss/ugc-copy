import { describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { ApiError, createApiClient } from '../lib/api-client';

const endpoints = mobileApiContract.endpoints;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A client whose every request is answered `answer`, and what it asked, as the server would see it. */
function client(answer: unknown, { status = 200, token = 'token-1' }: { status?: number; token?: string | null } = {}) {
  const asked: Array<{ url: URL; method: string; body: unknown; authorization: string | null }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({
      url: new URL(String(input)),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    return jsonResponse(answer, status);
  });
  const api = createApiClient({
    baseUrl: 'https://magicbooklet.test',
    getAccessToken: async () => token,
    fetcher: fetcher as unknown as typeof fetch,
  });
  return { api, asked };
}

describe("Help & Support's Updates and Roadmap through the API client", () => {
  it('asks for a page of updates with its cursor and size, with the session (a guest\'s too), and reads the contract\'s page', async () => {
    const { api, asked } = client(endpoints.getSupportUpdates.response, { token: 'guest-token' });

    const page = await api.getSupportUpdates({ cursor: 'cursor-2', limit: 1 });

    expect(asked).toHaveLength(1);
    expect(asked[0].method).toBe('GET');
    expect(asked[0].url.pathname).toBe('/api/support/updates');
    expect(Object.fromEntries(asked[0].url.searchParams)).toEqual({ cursor: 'cursor-2', limit: '1' });
    expect(asked[0].authorization).toBe('Bearer guest-token');
    expect(page).toEqual({
      updates: [{
        id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a',
        kind: 'announcement',
        title: 'Folders are here',
        body: 'Group your creations into folders from your profile. Tell us what you think in the comments.',
        createdAt: '2026-11-26T12:00:00.000Z',
        commentCount: 4,
        commentsLocked: false,
        reactions: { '👍': 12, '❤️': 3 },
        myReaction: '👍',
      }],
      nextCursor: null,
      latestAt: '2026-11-26T12:00:00.000Z',
    });
  });

  it('asks for the first page with no parameters, and never for `scope`, the web\'s visitor read', async () => {
    const { api, asked } = client(endpoints.getSupportUpdates.response);
    await api.getSupportUpdates();
    await api.getSupportUpdates({ cursor: null });
    expect(asked.map(({ url }) => url.search)).toEqual(['', '']);
  });

  it('sets, changes or takes away a reaction on an update and reads the counts back', async () => {
    const { api, asked } = client(endpoints.reactToSupportUpdate.response);

    const answer = await api.reactToSupportUpdate('post/1', '👍');
    expect(asked[0]).toMatchObject({ method: 'POST', body: endpoints.reactToSupportUpdate.request, authorization: 'Bearer token-1' });
    expect(asked[0].url.pathname).toBe('/api/support/updates/post%2F1/reaction');
    expect(answer).toEqual({ reactions: { '👍': 13, '❤️': 3 }, myReaction: '👍' });

    await api.reactToSupportUpdate('post-1', null);
    expect(asked[1].body).toEqual(endpoints.reactToSupportUpdate.requestVariants.remove);
  });

  it('reads the roadmap, every item the app draws', async () => {
    const { api, asked } = client(endpoints.getSupportRoadmap.response);

    const roadmap = await api.getSupportRoadmap();

    expect(asked[0]).toMatchObject({ method: 'GET', authorization: 'Bearer token-1' });
    expect(asked[0].url.pathname).toBe('/api/support/roadmap');
    expect(roadmap.items.map((item) => [item.title, item.status, item.shippedUpdateId, item.myReaction])).toEqual([
      ['Folders for creations', 'building', null, null],
      ['Text posts', 'shipped', '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a', '❤️'],
    ]);
  });

  it('reacts to a roadmap item the same way', async () => {
    const { api, asked } = client(endpoints.reactToSupportRoadmapItem.response);

    const answer = await api.reactToSupportRoadmapItem('item-1', '🙏');

    expect(asked[0]).toMatchObject({ method: 'POST', body: endpoints.reactToSupportRoadmapItem.request });
    expect(asked[0].url.pathname).toBe('/api/support/roadmap/item-1/reaction');
    expect(answer).toEqual({ reactions: { '🙏': 41, '👍': 18 }, myReaction: '🙏' });
  });

  it('fails, never reads as empty, on an answer the shared readers cannot take', async () => {
    for (const call of [
      (api: ReturnType<typeof client>['api']) => api.getSupportUpdates(),
      (api: ReturnType<typeof client>['api']) => api.getSupportRoadmap(),
      (api: ReturnType<typeof client>['api']) => api.reactToSupportUpdate('post-1', '👍'),
      (api: ReturnType<typeof client>['api']) => api.reactToSupportRoadmapItem('item-1', '👍'),
    ]) {
      const { api } = client({ myReaction: 'not one of the six', updates: 'nope', items: 'nope' });
      await expect(call(api)).rejects.toMatchObject({ name: 'ApiError', status: 502 });
    }
  });

  it("passes a refusal on with the server's words and code", async () => {
    const refusals = [
      endpoints.reactToSupportUpdate.errors.unauthorized,
      endpoints.reactToSupportUpdate.errors.registrationRequired,
      endpoints.reactToSupportUpdate.errors.invalidReaction,
      endpoints.reactToSupportRoadmapItem.errors.notFound,
    ];
    for (const refusal of refusals) {
      const { api } = client(refusal.response, { status: refusal.status });
      const error = await api.reactToSupportUpdate('post-1', '👍').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: refusal.status, message: refusal.response.error, code: refusal.response.code });
    }
  });
});
