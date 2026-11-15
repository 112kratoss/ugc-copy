import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession } } }));

import {
  isAgentAccessToken,
  pressedSearchResult,
  reportSearchOpen,
} from '@/components/search/search-open-report';
import type { SearchOpen } from '../../ugc-mobile/lib/public-search-policy/search-open-log';

const POST_ID = '0b9e1000-0000-4000-8000-000000000011';
const open: SearchOpen = { query: 'neon product', type: 'posts', sort: 'latest', entry: 'recent', kind: 'post', id: POST_ID, position: 3 };

/** A JWT-shaped token carrying the claims given; nothing verifies it here. */
function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
  return `${part({ alg: 'ES256' })}.${part(claims)}.signature`;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('reportSearchOpen (web)', () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    fetchMock.mockClear();
    getSession.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the open with keepalive and no token for a visitor, and returns before anything is sent', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    expect(reportSearchOpen(open)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/search/opened');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' } });
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(init.body as string)).toEqual({
      q: 'neon product', type: 'posts', sort: 'latest', entry: 'recent', kind: 'post', id: POST_ID, position: 3,
    });
  });

  it('sends the session’s token, as the search did, so the server keys both on the same viewer', async () => {
    const session = token({ sub: 'user-1', role: 'authenticated' });
    getSession.mockResolvedValue({ data: { session: { access_token: session } } });
    reportSearchOpen(open);
    await settle();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${session}` });
  });

  it('sends nothing for an agent’s token', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: token({ sub: 'user-1', client_id: 'client-claude' }) } } });
    reportSearchOpen(open);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing the server would refuse', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    reportSearchOpen({ ...open, id: 'luna-studio' });
    reportSearchOpen({ ...open, query: '  ' });
    reportSearchOpen({ ...open, position: 0 });
    await settle();
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws and leaves no unhandled rejection: a failed session read, a rejected fetch, a refusal', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      getSession.mockRejectedValueOnce(new Error('storage unavailable'));
      expect(() => reportSearchOpen(open)).not.toThrow();
      getSession.mockImplementationOnce(() => { throw new Error('no client'); });
      expect(() => reportSearchOpen(open)).not.toThrow();
      getSession.mockResolvedValue({ data: { session: null } });
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      expect(() => reportSearchOpen(open)).not.toThrow();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no' }), { status: 429 }));
      expect(() => reportSearchOpen(open)).not.toThrow();
      await settle();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('isAgentAccessToken', () => {
  it('is true only for a token carrying the agent claim', () => {
    expect(isAgentAccessToken(token({ sub: 'user-1', client_id: 'client-claude' }))).toBe(true);
    expect(isAgentAccessToken(token({ sub: 'user-1' }))).toBe(false);
    expect(isAgentAccessToken(token({ sub: 'user-1', client_id: '  ' }))).toBe(false);
    expect(isAgentAccessToken('not-a-jwt')).toBe(false);
    expect(isAgentAccessToken('a.%%%.c')).toBe(false);
    expect(isAgentAccessToken('')).toBe(false);
  });
});

describe('pressedSearchResult', () => {
  function results() {
    const container = document.createElement('div');
    container.innerHTML = `
      <a href="/creators/a" data-search-result="creator" data-search-result-id="c-1"><span id="in-c1">A</span></a>
      <a href="/creators/b" data-search-result="creator" data-search-result-id="c-2">B</a>
      <button id="see-all">See all</button>
      <a href="/showcase/1" data-search-result="post" data-search-result-id="p-1">One</a>
      <a href="/showcase/2" data-search-result="post" data-search-result-id="p-2"><img id="in-p2" alt="" /></a>
      <a href="/showcase/3" data-search-result="recipe" data-search-result-id="r-1">Recipe</a>
      <section id="related">
        <a href="/showcase/9" data-search-result="post" data-search-result-id="p-9">Related</a>
      </section>
      <a href="/pricing" id="plain">Plain link</a>
    `;
    return container;
  }

  it('says which result was pressed and its place among the results of its kind, counted from 1', () => {
    const container = results();
    expect(pressedSearchResult(container, container.querySelector('#in-c1'))).toEqual({ kind: 'creator', id: 'c-1', position: 1 });
    expect(pressedSearchResult(container, container.querySelector('#in-p2'))).toEqual({ kind: 'post', id: 'p-2', position: 2 });
    // A recipe's place is among the recipes, whatever stands above them.
    expect(pressedSearchResult(container, container.querySelector('[data-search-result-id="r-1"]'))).toEqual({ kind: 'recipe', id: 'r-1', position: 1 });
    // A related post follows the search's own posts.
    expect(pressedSearchResult(container, container.querySelector('[data-search-result-id="p-9"]'))).toEqual({ kind: 'post', id: 'p-9', position: 3 });
  });

  it('is null for a press that is not on a result', () => {
    const container = results();
    expect(pressedSearchResult(container, container.querySelector('#see-all'))).toBeNull();
    expect(pressedSearchResult(container, container.querySelector('#plain'))).toBeNull();
    expect(pressedSearchResult(container, null)).toBeNull();
    const outside = document.createElement('a');
    outside.setAttribute('href', '/showcase/1');
    outside.setAttribute('data-search-result', 'post');
    expect(pressedSearchResult(container, outside)).toBeNull();
  });
});
