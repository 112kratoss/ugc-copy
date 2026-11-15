import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShellSearch } from '@/components/AppShellSearch';
import { clearSearchFieldHandoff, searchFieldHandoffEntry, searchFieldHandoffPending } from '@/components/search/search-field-handoff';
import { forgetKeptSearchStarter } from '@/components/search/use-search-starter';

// The top bar's search field: Enter searches on the search page as it always
// did, and while the person types it offers what the search page's own box
// offers, each row leaving through the shell's leave guard. The list and its
// keys are the search page's (search-typeahead-client.test.tsx); this file
// holds where each row goes from here, and that the field costs a page
// nothing until it is used.

const { pushMock, holdMock, submitted } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  holdMock: vi.fn((_navigate: () => void) => false),
  submitted: [] as string[],
}));
const getSessionMock = vi.fn();
const suggestFetchMock = vi.fn();
// The starter's answer: none unless a case gives one (the route switched off), so the cases about
// typing see the field as it was before the start panel.
const starterFetchMock = vi.fn();
const fetchMock = (url: string) => (url.startsWith('/api/search/starter') ? starterFetchMock(url) : suggestFetchMock(url));
const HISTORY_KEY = 'magicbooklet:public-search-history:v1';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('next/form', () => ({
  // A GET form, as next/form is: a submit that nothing prevented goes to its action with its fields.
  default: ({ action, children, onSubmit, ...props }: React.ComponentProps<'form'> & { action: string }) => (
    <form
      {...props}
      action={action}
      onSubmit={(event) => {
        onSubmit?.(event);
        if (!event.defaultPrevented) {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          submitted.push(`${action}?${new URLSearchParams([...fields.entries()].map(([name, value]) => [name, String(value)])).toString()}`);
        }
      }}
    >
      {children}
    </form>
  ),
}));
vi.mock('@/lib/use-leave-guard', () => ({ holdForLeaveGuard: (navigate: () => void) => holdMock(navigate) }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

const answer = {
  query: 'lum',
  normalizedQuery: 'lum',
  creators: [{ id: 'c1', username: 'luma-studio', displayName: 'Luma Studio', avatarUrl: null, isFollowing: false }],
  entities: [{ kind: 'model', key: 'luma-ray-2', label: 'Luma Ray 2', postCount: 14, postCountCapped: false }],
  completions: [{ text: 'luminous portrait' }],
};

const box = () => screen.getByRole('combobox', { name: 'Search creators, posts, and recipes' });
async function typeFocused(value: string) {
  fireEvent.focus(box());
  fireEvent.change(box(), { target: { value } });
  return screen.findByRole('listbox', { name: 'Search suggestions' });
}

describe('top bar search', () => {
  beforeEach(() => {
    submitted.length = 0;
    pushMock.mockReset();
    holdMock.mockReset();
    holdMock.mockReturnValue(false);
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    suggestFetchMock.mockReset();
    suggestFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => answer });
    starterFetchMock.mockReset();
    starterFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    forgetKeptSearchStarter();
    window.localStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('searches what is typed on Enter, on the search page, as before', async () => {
    render(<AppShellSearch />);
    fireEvent.change(box(), { target: { value: 'neon city' } });
    fireEvent.submit(box().closest('form')!);
    expect(submitted).toEqual(['/search?q=neon+city']);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('hands the focus on to the search page\'s field: Enter and a row that opens the search page mark it', async () => {
    clearSearchFieldHandoff();
    render(<AppShellSearch />);
    expect(box()).toHaveAttribute('placeholder', 'Search');
    fireEvent.change(box(), { target: { value: 'neon city' } });
    fireEvent.submit(box().closest('form')!);
    expect(searchFieldHandoffPending()).toBe(true);
    // Said with it: how the search was entered, which the search page tells the search log.
    expect(searchFieldHandoffEntry()).toBe('typed');

    clearSearchFieldHandoff();
    await typeFocused('lum');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(pushMock).toHaveBeenLastCalledWith('/creators/luma-studio');
    // A profile is not the search page: nothing is handed on.
    expect(searchFieldHandoffPending()).toBe(false);
    clearSearchFieldHandoff();
  });

  it('hands nothing on for a leave the person cancels (review of #784)', () => {
    clearSearchFieldHandoff();
    // A page with unsaved work holds the leave and asks its question.
    let leave: (() => void) | null = null;
    holdMock.mockImplementation((navigate: () => void) => { leave = navigate; return true; });
    render(<AppShellSearch />);
    fireEvent.change(box(), { target: { value: 'neon city' } });
    fireEvent.submit(box().closest('form')!);
    expect(submitted).toEqual([]);
    expect(searchFieldHandoffPending()).toBe(false);

    // Confirmed, the leave submits again and is marked then.
    holdMock.mockImplementation(() => false);
    expect(leave).not.toBeNull();
    leave!();
    expect(submitted).toEqual(['/search?q=neon+city']);
    expect(searchFieldHandoffPending()).toBe(true);
    clearSearchFieldHandoff();
  });

  it('draws its own clear button, the browser\'s being hidden: it empties the field and keeps the focus there (review of #784)', () => {
    render(<AppShellSearch />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    box().focus();
    fireEvent.change(box(), { target: { value: 'neon' } });
    const clear = screen.getByRole('button', { name: 'Clear search' });
    // A finger's target, and a button the keyboard reaches.
    expect(clear.className).toContain('h-11');
    expect(clear.className).toContain('w-11');
    expect(clear.tabIndex).toBe(0);
    // A pointer press does not take the focus from the field first.
    expect(fireEvent.mouseDown(clear)).toBe(false);
    fireEvent.click(clear);
    expect(box()).toHaveValue('');
    expect(box()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('is a combobox that offers creators, models and tools, and completions while it has the focus', async () => {
    render(<AppShellSearch />);
    expect(box().getAttribute('aria-expanded')).toBe('false');
    // Typed without the focus (a value restored by the browser): nothing is asked.
    fireEvent.change(box(), { target: { value: 'lum' } });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(suggestFetchMock).not.toHaveBeenCalled();

    const list = await typeFocused('lum');
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(box().getAttribute('aria-controls')).toBe(list.id);
    expect(within(list).getAllByRole('option').map((option) => option.getAttribute('aria-label'))).toEqual([
      'Luma Studio, @luma-studio. Open profile',
      'Luma Ray 2, model, 14 posts. Show posts made with it',
      'Search for luminous portrait',
    ]);
    expect(suggestFetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/search/suggest?q=lum&catalog=1']);
  });

  it('takes each row where the search page would: a profile, Posts narrowed to the entity, a search', async () => {
    render(<AppShellSearch />);
    await typeFocused('lum');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(pushMock).toHaveBeenLastCalledWith('/creators/luma-studio');

    // Another text, then this one again: its list is offered anew. The model
    // went with "lumx" and is back with "lum": a row takes a press once it
    // has stood where it is for a moment, which the list says by not being busy.
    const settled = () => waitFor(() => expect(screen.getByRole('listbox').hasAttribute('aria-busy')).toBe(false));
    fireEvent.change(box(), { target: { value: 'lumx' } });
    fireEvent.change(box(), { target: { value: 'lum' } });
    // Until then the rows that moved are marked as settling, here as on the search page, and drawn as
    // every other row: nothing in the list is made fainter (owner, 2026-11-16).
    const moved = await screen.findByRole('option', { name: /Luma Ray 2/ });
    expect(moved.hasAttribute('data-settling')).toBe(true);
    expect(moved.className).not.toContain('opacity');
    expect(screen.getByRole('listbox').className).not.toContain('opacity');
    await settled();
    expect(screen.getByRole('option', { name: /Luma Ray 2/ }).hasAttribute('data-settling')).toBe(false);
    fireEvent.click(await screen.findByRole('option', { name: /Luma Ray 2/ }));
    expect(pushMock).toHaveBeenLastCalledWith('/search?q=lum&type=posts&madeWith=model%3Aluma-ray-2');
    // The address is the search page's own, with nothing added: the entry travels in the hand-off.
    expect(searchFieldHandoffEntry()).toBe('entity');

    // Another text, then this one again: its list is offered anew.
    fireEvent.change(box(), { target: { value: 'lumx' } });
    fireEvent.change(box(), { target: { value: 'lum' } });
    await settled();
    fireEvent.click(await screen.findByRole('option', { name: 'Search for luminous portrait' }));
    expect(pushMock).toHaveBeenLastCalledWith('/search?q=luminous+portrait');
    expect(searchFieldHandoffEntry()).toBe('suggestion');
    // A row is not the form's submit.
    expect(submitted).toEqual([]);
  });

  it('searches what is typed on Enter with nothing highlighted, the list out of the way', async () => {
    render(<AppShellSearch />);
    await typeFocused('lum');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.submit(box().closest('form')!);
    expect(submitted).toEqual(['/search?q=lum']);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('closes on Escape and keeps the text', async () => {
    render(<AppShellSearch />);
    await typeFocused('lum');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((box() as HTMLInputElement).value).toBe('lum');
  });

  it('asks a page with unsaved work before a row leaves it, and goes on a leave', async () => {
    // A page's guard holds the way out and keeps what would have happened.
    let leave: (() => void) | null = null;
    holdMock.mockImplementation((navigate) => { leave = navigate; return true; });
    render(<AppShellSearch />);
    await typeFocused('lum');
    fireEvent.click(screen.getByRole('option', { name: 'Search for luminous portrait' }));
    expect(holdMock).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
    leave!();
    expect(pushMock).toHaveBeenCalledWith('/search?q=luminous+portrait');

    // And the search itself, as before.
    fireEvent.submit(box().closest('form')!);
    expect(submitted).toEqual([]);
    expect(holdMock).toHaveBeenCalledTimes(2);
  });

  it('shows nothing for a failed answer, and the field still searches', async () => {
    suggestFetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Failed to load search suggestions.' }) });
    render(<AppShellSearch />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'lum' } });
    await waitFor(() => expect(suggestFetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.submit(box().closest('form')!);
    expect(submitted).toEqual(['/search?q=lum']);
  });

  it('costs a page nothing until it is used: the Supabase client is loaded with the first request', () => {
    // The field is on every page. The shell's other readers of the session
    // load the client when they need it (AuthProvider, useUnreadAlertsCount);
    // a static import here would put it in every page's first bundle.
    for (const file of ['components/AppShellSearch.tsx', 'components/search/use-search-typeahead.ts', 'components/search/use-search-starter.ts', 'components/search/search-start-panel.ts', 'components/search/SearchTypeaheadList.tsx']) {
      const source = readFileSync(join(process.cwd(), 'src', file), 'utf8');
      expect(source, file).not.toMatch(/^import [^;]*from '@\/lib\/supabase';/m);
    }
    expect(readFileSync(join(process.cwd(), 'src/components/search/use-search-typeahead.ts'), 'utf8'))
      .toContain("import('@/lib/supabase')");
    // Nor the search page's start screen with its cards and Follow buttons: the bar reads the answer alone.
    expect(readFileSync(join(process.cwd(), 'src/components/AppShellSearch.tsx'), 'utf8')).not.toContain('/SearchStarter');
  });
});

// ─── The panel a click opens, before anything is typed (owner, 2026-11-16) ───

const thumbnail = (n: number) => ({ postId: `p${n}`, url: `https://cdn.example/p${n}.webp`, thumbhash: null, width: 900, height: 1200, mediaKind: 'image' });
const starter = {
  entities: [
    { kind: 'model', key: 'nano-banana-pro', label: 'Nano Banana Pro', postCount: 200, postCountCapped: true, query: 'nano banana pro', thumbnail: thumbnail(1) },
    { kind: 'tool', key: 'midjourney', label: 'Midjourney', postCount: 14, postCountCapped: false, query: 'midjourney', thumbnail: null },
  ],
  creators: [{ id: 'c9', username: 'luna-studio', displayName: 'Luna Studio', bio: null, avatarUrl: null, publicPostCount: 42, isFollowing: false }],
  searches: [{ text: 'portrait', thumbnail: thumbnail(3) }, { text: 'anime', thumbnail: null }],
  periods: { entities: 'week', creators: 'all', searches: 'all' },
};
const panel = () => screen.findByRole('listbox', { name: 'Search suggestions' });
const names = () => screen.getAllByRole('option').map((option) => option.getAttribute('aria-label'));
const starterAsked = () => starterFetchMock.mock.calls.length;
/** The list's own classes and its rows' that touch opacity: none (a picture's own load fade is inside a row, and is not the row). */
const strengths = (list: HTMLElement) => [list, ...within(list).getAllByRole('option')]
  .flatMap((element) => element.className.split(/\s+/).filter((name) => name.includes('opacity')));

describe('top bar search: the panel on an empty box', () => {
  beforeEach(() => {
    submitted.length = 0;
    pushMock.mockReset();
    holdMock.mockReset();
    holdMock.mockReturnValue(false);
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    suggestFetchMock.mockReset();
    suggestFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => answer });
    starterFetchMock.mockReset();
    starterFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => starter });
    forgetKeptSearchStarter();
    clearSearchFieldHandoff();
    window.localStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks nothing until the field is reached for, then once for the visit', async () => {
    const first = render(<AppShellSearch />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(starterAsked()).toBe(0);
    // The pointer over the field: asked ahead of the click, so the panel has its lists as it opens.
    fireEvent.pointerEnter(box().closest('form')!);
    await waitFor(() => expect(starterAsked()).toBe(1));
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.focus(box());
    await panel();
    await waitFor(() => expect(names()).toHaveLength(4));
    // Leaving the field and coming back, and the field itself coming back (the bar leaves the page on Search).
    fireEvent.blur(box());
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.focus(box());
    await panel();
    first.unmount();
    render(<AppShellSearch />);
    fireEvent.focus(box());
    await panel();
    await waitFor(() => expect(names()).toHaveLength(4));
    expect(starterAsked()).toBe(1);
  });

  it('opens on the focus with recent searches first, then the starter’s models and tools and its searches, named as on the search page', async () => {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(['neon harbor', 'glowing lumen']));
    let land: (value: unknown) => void = () => {};
    starterFetchMock.mockReturnValue(new Promise((resolve) => { land = resolve; }));
    render(<AppShellSearch />);
    expect(box().getAttribute('aria-expanded')).toBe('false');
    fireEvent.focus(box());
    const list = await panel();
    // The recent searches are this browser's own: there at once, before any answer.
    await waitFor(() => expect(starterAsked()).toBe(1));
    expect(names()).toEqual(['Search again for neon harbor', 'Search again for glowing lumen']);
    await act(async () => { land({ ok: true, status: 200, json: async () => starter }); });
    await waitFor(() => expect(names()).toEqual([
      'Search again for neon harbor',
      'Search again for glowing lumen',
      'Nano Banana Pro, model, 200+ posts. Show posts made with it',
      'Midjourney, tool, 14 posts. Show posts made with it',
      'Search for portrait',
      'Search for anime',
    ]));
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(box().getAttribute('aria-controls')).toBe(list.id);
    expect(within(list).getAllByRole('group').map((group) => document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent))
      .toEqual(['Recent searches', 'Popular this week', 'Try searching for']);
    // A creator's row carries a Follow button: left to the search page.
    expect(screen.queryByText('Luna Studio')).toBeNull();
    // Pictures where the starter has them, the glyph in the same frame where not.
    expect(within(screen.getByRole('option', { name: /^Nano Banana Pro/ })).getByRole('presentation', { hidden: true }).getAttribute('src')).toBe('https://cdn.example/p1.webp');
    expect(screen.getByRole('option', { name: 'Search for portrait' }).querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/p3.webp');
    expect(screen.getByRole('option', { name: 'Search for anime' }).querySelector('[data-search-picture="placeholder"]')).not.toBeNull();
    // Simply there: no entrance to fade it in over the page.
    expect(list.className).not.toMatch(/ui-enter|animate|transition/);
  });

  it('walks the rows with the arrows, picks with Enter and a press, and says how each search was entered', async () => {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(['neon harbor']));
    render(<AppShellSearch />);
    fireEvent.focus(box());
    await panel();
    await waitFor(() => expect(names()).toHaveLength(5));

    // Down from the box is the first row, named to the box; Enter searches it again.
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Search again for neon harbor' }).getAttribute('aria-selected')).toBe('true');
    expect(box().getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Search again for neon harbor' }).id);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(pushMock).toHaveBeenLastCalledWith('/search?q=neon+harbor');
    expect(searchFieldHandoffEntry()).toBe('recent');
    expect(box()).toHaveValue('neon harbor');

    // A model: Posts for its own query, narrowed to it, as the search page's start screen opens it.
    fireEvent.change(box(), { target: { value: '' } });
    await panel();
    fireEvent.click(screen.getByRole('option', { name: /^Nano Banana Pro/ }));
    expect(pushMock).toHaveBeenLastCalledWith('/search?q=nano+banana+pro&type=posts&madeWith=model%3Anano-banana-pro');
    expect(searchFieldHandoffEntry()).toBe('entity');

    // A search the starter offers (the panel closed with the row; a click in the field asks for it again).
    fireEvent.click(box());
    fireEvent.click(await screen.findByRole('option', { name: 'Search for portrait' }));
    expect(pushMock).toHaveBeenLastCalledWith('/search?q=portrait');
    expect(searchFieldHandoffEntry()).toBe('starter');
    expect(submitted).toEqual([]);
  });

  it('closes on Escape, opens again on Down, on a click in the field and on coming back to it', async () => {
    render(<AppShellSearch />);
    fireEvent.focus(box());
    await panel();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box().getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(box());
    await panel();

    fireEvent.keyDown(box(), { key: 'Escape' });
    fireEvent.blur(box());
    fireEvent.focus(box());
    await panel();
  });

  it('forgets one recent search, or all of them, and keeps the focus in the field', async () => {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(['neon harbor', 'glowing lumen', 'lumen city', 'fourth search']));
    render(<AppShellSearch />);
    box().focus();
    const list = await panel();
    await waitFor(() => expect(names()).toHaveLength(7));
    const remove = screen.getByRole('button', { name: 'Remove glowing lumen from recent searches' });
    // A second control beside the row, never inside the option; a press leaves the focus in the field.
    expect(remove.closest('[role="option"]')).toBeNull();
    expect(fireEvent.mouseDown(remove)).toBe(false);
    fireEvent.click(remove);
    // The next one kept comes into the three shown.
    expect(names().slice(0, 3)).toEqual(['Search again for neon harbor', 'Search again for lumen city', 'Search again for fourth search']);
    expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]')).toEqual(['neon harbor', 'lumen city', 'fourth search']);
    expect(box()).toHaveFocus();

    // Escape from a button the Tab key reached closes the panel and returns the focus to the field.
    const clear = within(list).getByRole('button', { name: 'Clear all recent searches' });
    clear.focus();
    expect(screen.getByRole('listbox')).toBe(list);
    fireEvent.keyDown(clear, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box()).toHaveFocus();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });

    fireEvent.click(within(screen.getByRole('listbox')).getByRole('button', { name: 'Clear all recent searches' }));
    expect(names()).toEqual([
      'Nano Banana Pro, model, 200+ posts. Show posts made with it',
      'Midjourney, tool, 14 posts. Show posts made with it',
      'Search for portrait',
      'Search for anime',
    ]);
    expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear all recent searches' })).toBeNull();
    expect(box()).toHaveFocus();
  });

  it('keeps the panel on show over the first letter until its answer lands, then fills it in place: never gone, never fainter', async () => {
    let land: (value: unknown) => void = () => {};
    suggestFetchMock.mockReturnValue(new Promise((resolve) => { land = resolve; }));
    render(<AppShellSearch />);
    fireEvent.focus(box());
    const list = await panel();
    await waitFor(() => expect(names()).toHaveLength(4));
    const before = names();

    fireEvent.change(box(), { target: { value: 'lum' } });
    // The answer for "lum" is on its way: the same element, the same rows, said to be busy and drawn as before.
    expect(screen.getByRole('listbox')).toBe(list);
    expect(names()).toEqual(before);
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(strengths(list)).toEqual([]);
    // A row still does what it shows.
    await waitFor(() => expect(suggestFetchMock).toHaveBeenCalledTimes(1));

    await act(async () => { land({ ok: true, status: 200, json: async () => answer }); });
    await waitFor(() => expect(names()).toEqual([
      'Luma Studio, @luma-studio. Open profile',
      'Luma Ray 2, model, 14 posts. Show posts made with it',
      'Search for luminous portrait',
    ]));
    // Replaced in place: the element that was there.
    expect(screen.getByRole('listbox')).toBe(list);
    expect(strengths(list)).toEqual([]);

    // A text with an answer of nothing closes it; it does not bring the start panel back mid-word.
    suggestFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ query: 'lumq', normalizedQuery: 'lumq', creators: [], entities: [], completions: [] }) });
    fireEvent.change(box(), { target: { value: 'lumq' } });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    // Emptied, the box has its panel again, at once.
    fireEvent.change(box(), { target: { value: '' } });
    expect(names()).toEqual(before);
  });

  it('opens no panel where there is nothing to offer, and the field still offers its list while typing', async () => {
    starterFetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    render(<AppShellSearch />);
    fireEvent.focus(box());
    await waitFor(() => expect(starterAsked()).toBe(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.change(box(), { target: { value: 'lum' } });
    await panel();
    expect(names()).toHaveLength(3);
  });
});
