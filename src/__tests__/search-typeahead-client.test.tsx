import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchClient from '@/app/search/SearchClient';
import type { PublicSearchResponse } from '@/lib/public-search';

import {
  SEARCH_TYPEAHEAD_DEBOUNCE_MS,
  type SearchSuggestResponse,
} from '../../ugc-mobile/lib/public-search-policy/search-typeahead';

// The search page's typeahead, drawn by the real page over stubbed requests:
// when it asks, which answer it draws, the combobox it is to assistive
// technology, and what each key and press does. Its rules are held by
// search-typeahead-policy.test.ts; a browser's view of it by
// tests/e2e/search-typeahead.spec.ts.

const { pushMock, routerMock } = vi.hoisted(() => {
  const push = vi.fn();
  return { pushMock: push, routerMock: { push, replace: vi.fn() } };
});
const getSessionMock = vi.fn();
const searchFetchMock = vi.fn();
const suggestFetchMock = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

function searchAnswer(query: string): PublicSearchResponse {
  return {
    query,
    normalizedQuery: query,
    type: 'top',
    sort: 'top',
    entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null },
    exact: false,
    creators: { items: [], nextCursor: null },
    posts: { items: [], nextCursor: null },
    recipes: { items: [], nextCursor: null },
  };
}

function suggestions(overrides: Partial<SearchSuggestResponse> = {}): SearchSuggestResponse {
  return {
    query: 'lum',
    normalizedQuery: 'lum',
    creators: [
      { id: 'c1', username: 'luma-studio', displayName: 'Luma Studio', avatarUrl: null, isFollowing: true },
      { id: 'c2', username: 'lumen', displayName: 'lumen', avatarUrl: null, isFollowing: false },
    ],
    entities: [{ kind: 'model', key: 'luma-ray-2', label: 'Luma Ray 2', postCount: 14, postCountCapped: false }],
    completions: [{ text: 'luminous' }, { text: 'lumen glow' }],
    ...overrides,
  };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function suggestRequests(): string[] {
  return suggestFetchMock.mock.calls.map(([url]) => url as string);
}

function searchRequests(): string[] {
  return searchFetchMock.mock.calls.map(([url]) => url as string);
}

const box = () => screen.getByRole('combobox');
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const key = (name: string) => fireEvent.keyDown(box(), { key: name });
const list = () => screen.findByRole('listbox', { name: 'Search suggestions' });
const noList = () => expect(screen.queryByRole('listbox')).toBeNull();
/** Past the typeahead's pause, so a request that was going to be made has been. */
const pastThePause = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, SEARCH_TYPEAHEAD_DEBOUNCE_MS + 60)); });

describe('search page typeahead', () => {
  beforeEach(() => {
    window.localStorage.clear();
    pushMock.mockReset();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    searchFetchMock.mockReset();
    searchFetchMock.mockImplementation(async (url: string) => ok(searchAnswer(new URL(url, 'http://localhost').searchParams.get('q') ?? '')));
    suggestFetchMock.mockReset();
    suggestFetchMock.mockResolvedValue(ok(suggestions()));
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => (
      String(url).startsWith('/api/search/suggest') ? suggestFetchMock(url, init) : searchFetchMock(url, init)
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a combobox that controls a listbox of creators, then models and tools, then completions', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    // Closed until there is something to offer, and naming no list that is not drawn.
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(box().getAttribute('aria-autocomplete')).toBe('list');
    expect(box().getAttribute('aria-haspopup')).toBe('listbox');
    expect(box().hasAttribute('aria-controls')).toBe(false);

    type('lum');
    const listbox = await list();
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(box().getAttribute('aria-controls')).toBe(listbox.id);
    expect(box().hasAttribute('aria-activedescendant')).toBe(false);

    const groups = within(listbox).getAllByRole('group');
    expect(groups.map((group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent))
      .toEqual(['Creators', 'Models and tools', 'Suggested searches']);
    expect(within(listbox).getAllByRole('option').map((option) => option.getAttribute('aria-label'))).toEqual([
      'Luma Studio, @luma-studio, following. Open profile',
      '@lumen. Open profile',
      'Luma Ray 2, model, 14 posts. Show posts made with it',
      'Search for luminous',
      'Search for lumen glow',
    ]);
    // No row is focusable: the focus stays in the box, so it is never trapped in the list.
    expect(within(listbox).queryAllByRole('button')).toHaveLength(0);
    expect(listbox.querySelectorAll('[tabindex], a[href]')).toHaveLength(0);
    // Said politely, apart from the results' own status.
    expect(document.querySelector('[data-search-typeahead-status]')?.textContent).toBe('5 suggestions');
    expect(document.querySelector('[data-search-typeahead-status]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('asks once per pause in typing, for what the box holds, with the viewer’s token', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-1', user: { id: 'u1' } } } });
    render(<SearchClient initialQuery="" initialType="top" />);
    type('l');
    type('lu');
    type(' Lum ');
    await list();
    // The two earlier texts never reached their pause.
    expect(suggestRequests()).toEqual(['/api/search/suggest?q=Lum']);
    expect((suggestFetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ Authorization: 'Bearer token-1' });
    // A handle is asked for as one, and a query for one keeps its @.
    type('@lu');
    await waitFor(() => expect(suggestRequests()).toContain('/api/search/suggest?q=%40lu'));
  });

  it('asks nothing while the box does not have the focus, as on arrival from a shared link', async () => {
    render(<SearchClient initialQuery="luma" initialType="top" />);
    await waitFor(() => expect(searchRequests()).toHaveLength(1));
    await pastThePause();
    expect(suggestRequests()).toEqual([]);
    noList();
    // The focus in the box is what starts it.
    fireEvent.focus(box());
    await waitFor(() => expect(suggestRequests()).toEqual(['/api/search/suggest?q=luma']));
  });

  it('draws no answer for a text the box no longer holds', async () => {
    const early = deferred<ReturnType<typeof ok>>();
    suggestFetchMock.mockReturnValueOnce(early.promise);
    suggestFetchMock.mockResolvedValueOnce(ok(suggestions({ creators: [], entities: [], completions: [{ text: 'lumina' }] })));
    render(<SearchClient initialQuery="" initialType="top" />);

    type('lu');
    await waitFor(() => expect(suggestRequests()).toEqual(['/api/search/suggest?q=lu']));
    // The person types on before the answer for "lu" is back, and its request is aborted.
    type('lum');
    expect((suggestFetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    await act(async () => {
      early.resolve(ok(suggestions({ completions: [{ text: 'lunar stale' }] })));
      await early.promise;
    });
    expect(screen.queryByText('lunar stale')).toBeNull();

    // The answer for what the box holds is the one drawn.
    const listbox = await list();
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual(['lumina']);
  });

  it('keeps an answer it had, so deleting a letter redraws the list without asking again', async () => {
    suggestFetchMock.mockImplementation(async (url: string) => {
      const q = new URL(url, 'http://localhost').searchParams.get('q') ?? '';
      return ok(suggestions({ creators: [], entities: [], completions: [{ text: `${q}inous` }] }));
    });
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    await screen.findByText('luminous');
    type('lumi');
    await screen.findByText('lumiinous');
    type('lum');
    await screen.findByText('luminous');
    expect(suggestRequests()).toEqual(['/api/search/suggest?q=lum', '/api/search/suggest?q=lumi']);
  });

  it('moves the highlight with the arrows, Home and End, and back to the box past either end', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    const listbox = await list();
    const options = within(listbox).getAllByRole('option');
    const active = () => box().getAttribute('aria-activedescendant');
    const selected = () => options.filter((option) => option.getAttribute('aria-selected') === 'true');

    expect(selected()).toHaveLength(0);
    key('ArrowDown');
    expect(active()).toBe(options[0].id);
    expect(selected()).toEqual([options[0]]);
    key('ArrowDown');
    expect(active()).toBe(options[1].id);
    key('End');
    expect(active()).toBe(options[4].id);
    // Past the last row the highlight is back in the box.
    key('ArrowDown');
    expect(active()).toBeNull();
    expect(selected()).toHaveLength(0);
    // Up from the box is the last row; Home the first.
    key('ArrowUp');
    expect(active()).toBe(options[4].id);
    key('Home');
    expect(active()).toBe(options[0].id);
    key('ArrowUp');
    expect(active()).toBeNull();
    // With no row highlighted, Home and End are the caret's: not taken.
    expect(fireEvent.keyDown(box(), { key: 'Home' })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: 'End' })).toBe(true);
    expect(active()).toBeNull();
    // The arrows are taken, so the caret does not jump in the text.
    expect(fireEvent.keyDown(box(), { key: 'ArrowDown' })).toBe(false);
  });

  it('opens a creator’s profile on Enter', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    await list();
    key('ArrowDown');
    key('Enter');
    expect(pushMock).toHaveBeenCalledWith('/creators/luma-studio');
    // The box keeps its text, and the list is out of the way.
    expect((box() as HTMLInputElement).value).toBe('lum');
    noList();
  });

  it('opens Posts narrowed to a model or tool, as pressing the entity among the results does', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    await list();
    key('ArrowDown');
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    await waitFor(() => expect(searchRequests()).toContain('/api/search?q=lum&type=posts&madeWith=model%3Aluma-ray-2'));
    expect(screen.getByRole('tab', { name: 'Posts' }).getAttribute('aria-selected')).toBe('true');
    // Named on its chip at once, before the narrowed search answers.
    expect(screen.getByRole('button', { name: 'Remove filter: made with Luma Ray 2' })).toBeTruthy();
    expect((box() as HTMLInputElement).value).toBe('lum');
    noList();
  });

  it('fills the box with a completion and searches for it at once, the list closed over it', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    await list();
    const before = Date.now();
    key('ArrowUp');
    key('ArrowUp');
    key('Enter');
    expect((box() as HTMLInputElement).value).toBe('luminous');
    // No pause for typing: the person chose this search.
    await waitFor(() => expect(searchRequests()).toContain('/api/search?q=luminous&type=top'));
    expect(Date.now() - before).toBeLessThan(280);
    // The completion's own suggestions are not drawn over the results it asked for.
    await pastThePause();
    noList();
    expect(box().getAttribute('aria-expanded')).toBe('false');
    // Typing again opens the list again.
    suggestFetchMock.mockResolvedValue(ok(suggestions({ creators: [], entities: [], completions: [{ text: 'luminous glow' }] })));
    type('luminous g');
    expect(await screen.findByRole('option', { name: 'Search for luminous glow' })).toBeTruthy();
  });

  it('searches what is typed on Enter with nothing highlighted, and closes the list', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    await list();
    key('Enter');
    noList();
    expect((box() as HTMLInputElement).value).toBe('lum');
    expect(pushMock).not.toHaveBeenCalled();
    await waitFor(() => expect(searchRequests()).toContain('/api/search?q=lum&type=top'));
    // Down opens it again for the same text.
    key('ArrowDown');
    expect(await list()).toBeTruthy();
  });

  it('closes on Escape and keeps the text; Escape again clears the box as before', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    await list();
    key('Escape');
    noList();
    expect((box() as HTMLInputElement).value).toBe('lum');
    expect(box().getAttribute('aria-expanded')).toBe('false');
    key('Escape');
    expect((box() as HTMLInputElement).value).toBe('');
  });

  it('takes a press on a row without the box losing the focus first', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    const listbox = await list();
    // A mouse down that moved the focus would close the list under the pointer.
    expect(fireEvent.mouseDown(listbox)).toBe(false);
    fireEvent.click(within(listbox).getByRole('option', { name: 'Search for lumen glow' }));
    expect((box() as HTMLInputElement).value).toBe('lumen glow');
    await waitFor(() => expect(searchRequests()).toContain('/api/search?q=lumen+glow&type=top'));
    noList();

    type('lum');
    fireEvent.click(await screen.findByRole('option', { name: '@lumen. Open profile' }));
    expect(pushMock).toHaveBeenCalledWith('/creators/lumen');
  });

  it('closes when the focus leaves the search form', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    await list();
    fireEvent.blur(box(), { relatedTarget: screen.getByRole('tab', { name: 'Top' }) });
    noList();
    fireEvent.focus(box());
    expect(await list()).toBeTruthy();
  });

  it.each([
    ['a failed request', () => ({ ok: false, status: 500, json: async () => ({ error: 'Failed to load search suggestions.' }) })],
    ['a body that is not an answer', () => ok({ query: 'lum', type: 'top', creators: { items: [] }, posts: { items: [] } })],
    ['a switched-off route’s empty answer', () => ok({ query: 'lum', normalizedQuery: 'lum', creators: [], entities: [], completions: [] })],
    ['a body that is not JSON', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } })],
  ])('shows nothing, and no error, for %s', async (_name, reply) => {
    suggestFetchMock.mockImplementation(async () => reply());
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    await waitFor(() => expect(suggestRequests()).toHaveLength(1));
    await pastThePause();
    noList();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-search-typeahead-status]')?.textContent).toBe('');
    // The search itself is untouched.
    await waitFor(() => expect(searchRequests()).toContain('/api/search?q=lum&type=top'));
  });

  it('shows nothing for a request that never reached the server', async () => {
    suggestFetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    await waitFor(() => expect(suggestRequests()).toHaveLength(1));
    await pastThePause();
    noList();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows nothing when rate limited, and asks no more until the limit has passed', async () => {
    suggestFetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ code: 'RATE_LIMITED', retryAfterSeconds: 30 }) });
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lum');
    await waitFor(() => expect(suggestRequests()).toHaveLength(1));
    type('lumi');
    type('lumin');
    await pastThePause();
    expect(suggestRequests()).toHaveLength(1);
    noList();
    expect(screen.queryByText(/busy|limit|try again/i)).toBeNull();
  });

  it('draws no model or tool for two characters, whatever an answer carries', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('lu');
    const listbox = await list();
    expect(within(listbox).queryByText('Models and tools')).toBeNull();
    expect(within(listbox).getAllByRole('option')).toHaveLength(4);
  });

  it('leaves recent searches as they were while the box is empty', async () => {
    window.localStorage.setItem('magicbooklet:public-search-history:v1', JSON.stringify(['neon harbor']));
    render(<SearchClient initialQuery="" initialType="top" />);
    expect(await screen.findByRole('button', { name: 'Search again for neon harbor' })).toBeTruthy();
    noList();
    expect(suggestRequests()).toEqual([]);
    // With text, the typeahead takes the place under the box.
    type('lum');
    await list();
    expect(screen.queryByRole('button', { name: 'Search again for neon harbor' })).toBeNull();
  });
});
