import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SearchClient from '@/app/search/SearchClient';
import type { PublicSearchResponse } from '@/lib/public-search';

// The router must be referentially stable across renders like Next's real
// one: SearchClient lists it in an effect dependency array, so a fresh object
// per render turns that effect into an infinite re-render loop.
const { replaceMock, routerMock } = vi.hoisted(() => {
  const replace = vi.fn();
  return { replaceMock: replace, routerMock: { replace } };
});
const getSessionMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
    },
  },
}));

function searchResponse(overrides: Partial<PublicSearchResponse> = {}): PublicSearchResponse {
  return {
    query: 'luna',
    normalizedQuery: 'luna',
    type: 'top',
    creators: { items: [], nextCursor: null },
    posts: { items: [], nextCursor: null },
    recipes: { items: [], nextCursor: null },
    ...overrides,
  };
}

function jsonResponse(body: PublicSearchResponse) {
  return { ok: true, status: 200, json: async () => body };
}

describe('SearchClient', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    getSessionMock.mockReset();
    fetchMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue(jsonResponse(searchResponse()));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('renders the initial guidance state until two characters are typed', () => {
    render(<SearchClient initialQuery="" initialType="top" />);

    expect(screen.getByText('Start with a creator or idea')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('debounces a bearer-authenticated search and announces the settled count', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-1' } } });
    fetchMock.mockResolvedValue(jsonResponse(searchResponse({
      creators: {
        items: [{
          id: 'creator-1',
          username: 'luna-studio',
          displayName: 'Luna Studio',
          bio: null,
          avatarUrl: null,
          publicPostCount: 3,
          isFollowing: false,
        }],
        nextCursor: null,
      },
    })));

    render(<SearchClient initialQuery="luna" initialType="top" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/search?q=luna&type=top');
    expect(init.headers).toEqual({ Authorization: 'Bearer token-1' });

    expect(await screen.findByText('Luna Studio')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 result for luna');
    expect(replaceMock).toHaveBeenCalledWith('/search?q=luna', { scroll: false });
  });

  it('forces a two-character query onto the creators tab and disables content tabs', async () => {
    render(<SearchClient initialQuery="ab" initialType="posts" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/search?q=ab&type=creators');
    expect(screen.getByRole('tab', { name: 'Posts' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Recipes' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Creators' })).toHaveAttribute('aria-selected', 'true');
  });

  it('clears the query with Escape and returns to the initial state', async () => {
    render(<SearchClient initialQuery="luna" initialType="top" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 });

    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });

    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect(await screen.findByText('Start with a creator or idea')).toBeInTheDocument();
  });
});
