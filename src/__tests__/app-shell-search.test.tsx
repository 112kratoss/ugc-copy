import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShellSearch } from '@/components/AppShellSearch';

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
    vi.stubGlobal('fetch', suggestFetchMock);
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
    expect(suggestFetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/search/suggest?q=lum']);
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
    // Until then the rows that moved are dimmed, here as on the search page.
    expect((await screen.findByRole('option', { name: /Luma Ray 2/ })).classList.contains('opacity-60')).toBe(true);
    await settled();
    expect(screen.getByRole('option', { name: /Luma Ray 2/ }).classList.contains('opacity-60')).toBe(false);
    fireEvent.click(await screen.findByRole('option', { name: /Luma Ray 2/ }));
    expect(pushMock).toHaveBeenLastCalledWith('/search?q=lum&type=posts&madeWith=model%3Aluma-ray-2');

    // Another text, then this one again: its list is offered anew.
    fireEvent.change(box(), { target: { value: 'lumx' } });
    fireEvent.change(box(), { target: { value: 'lum' } });
    await settled();
    fireEvent.click(await screen.findByRole('option', { name: 'Search for luminous portrait' }));
    expect(pushMock).toHaveBeenLastCalledWith('/search?q=luminous+portrait');
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
    for (const file of ['components/AppShellSearch.tsx', 'components/search/use-search-typeahead.ts', 'components/search/SearchTypeaheadList.tsx']) {
      const source = readFileSync(join(process.cwd(), 'src', file), 'utf8');
      expect(source, file).not.toMatch(/^import [^;]*from '@\/lib\/supabase';/m);
    }
    expect(readFileSync(join(process.cwd(), 'src/components/search/use-search-typeahead.ts'), 'utf8'))
      .toContain("import('@/lib/supabase')");
  });
});
