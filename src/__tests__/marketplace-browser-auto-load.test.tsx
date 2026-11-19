import { StrictMode, type AnchorHTMLAttributes, type ComponentProps, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplaceBrowser from '@/app/marketplace/MarketplaceBrowser';
import { marketplaceFiltersKey } from '@/app/marketplace/marketplace-address';
import {
  buildMarketplacePagesKey,
  MARKETPLACE_PAGES_MEMORY_MAX_ITEMS,
  recallMarketplacePages,
  rememberMarketplacePages,
} from '@/lib/marketplace-pages-memory';

import { createMarketplacePage as createPage } from './fixtures/marketplace-listing';

// Owner's report, 2026-11-20: on Marketplace every page after the first needed a press of "Load
// more recipes". The list now asks for its next page by itself once the reader has scrolled (a
// gesture of theirs, `useReaderScrolled`) and its end comes within 600 px of the window, as Home's
// feed does, and with Home's waits after a failed page (#878: a fresh observer fired at once after
// every failure, and a phone sent Home 225 failing requests in 5.5 s). The button stays, for a
// keyboard and for a page that failed. The clock moves in small acts and a page fails after a little
// while, as a network fails it: one act around a long advance, or a failure in the same tick, hides
// a loop that needs a render between two asks.

const LISTING = marketplaceFiltersKey({ access: 'all', resource: 'all', tool: '', sort: 'recent', q: '' });

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => null,
}));

const authState = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
  user: null as { id: string } | null,
  isLoading: false,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: authState.session, user: authState.user, isLoading: authState.isLoading }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const INITIAL_FILTERS = {
  access: 'all' as const,
  resource: 'all' as const,
  tool: '',
  sort: 'recent' as const,
  q: '',
};

type Watcher = { notify: (inReach: boolean) => void };

/**
 * Where the list's end stands, as a browser's observer reports it: once as soon as an observer
 * watches it, and again each time the end crosses the observer's margin (`moveEnd`). A notice
 * queued before a disconnect is still delivered, as the specification has it. `holdNotices` keeps
 * the first notices until `deliverHeldNotices`, as a browser holds them to its next frame.
 */
function stubListEnd({ inReach, holdNotices = false }: { inReach: boolean; holdNotices?: boolean }) {
  const state = { inReach, margins: [] as string[] };
  const watching = new Set<Watcher>();
  const held: Array<() => void> = [];
  vi.stubGlobal('IntersectionObserver', class {
    private readonly watcher: Watcher;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      state.margins.push(String(options?.rootMargin));
      const observer = this as unknown as IntersectionObserver;
      this.watcher = {
        notify: (now) => callback([{ isIntersecting: now } as IntersectionObserverEntry], observer),
      };
    }
    observe() {
      watching.add(this.watcher);
      const now = state.inReach;
      const notice = () => this.watcher.notify(now);
      if (holdNotices) held.push(notice);
      else queueMicrotask(notice);
    }
    unobserve() {}
    disconnect() {
      watching.delete(this.watcher);
    }
    takeRecords() {
      return [];
    }
  });
  return {
    margins: state.margins,
    /** The reader scrolls: the list's end comes within the margin, or leaves it. */
    moveEnd(now: boolean) {
      state.inReach = now;
      for (const watcher of [...watching]) watcher.notify(now);
    },
    deliverHeldNotices() {
      for (const notice of held.splice(0)) notice();
    },
  };
}

/**
 * Moves the clock in small steps, each its own act(), so the list renders and runs its effects
 * between the network's answers as a browser does.
 */
async function advance(ms: number, step = 20) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
    });
  }
}

function placeWindowAt(scrollY: number) {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: scrollY });
}

/** The reader turns the wheel, and the page moves `by` pixels. */
async function readerScrolls(by: number) {
  await act(async () => {
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: by }));
    placeWindowAt(window.scrollY + by);
    window.dispatchEvent(new Event('scroll'));
  });
}

/** The window moves with no gesture of the reader's: the browser putting Back's place back. */
async function windowMovesTo(scrollY: number) {
  await act(async () => {
    placeWindowAt(scrollY);
    window.dispatchEvent(new Event('scroll'));
  });
}

function answer(page: ReturnType<typeof createPage>) {
  return new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** A page the way a network gives one: after a little while, so the list draws its loading state first. */
async function answerAfter(page: ReturnType<typeof createPage>, ms = 40) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return answer(page);
}

async function failAfter(ms = 40) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return new Response(JSON.stringify({ error: 'Could not load more recipes.' }), { status: 503 });
}

/**
 * Twelve recipes from wherever the list asked, with more after them until `total`. Each page lands
 * below the reader and puts the list's end out of reach, as three rows of recipes do in a browser.
 */
function answerEachPage(end: ReturnType<typeof stubListEnd>, total = 100) {
  return async (input: RequestInfo | URL) => {
    const offset = Number(new URL(String(input), 'http://localhost').searchParams.get('offset'));
    const count = Math.min(12, total - offset);
    const page = await answerAfter(createPage(count, offset + count < total, offset, 12));
    end.moveEnd(false);
    return page;
  };
}

const listRequests = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
  .map(([input]) => String(input))
  .filter((url) => url.startsWith('/api/marketplace/resources'));

const drawnTitles = () => screen.getAllByRole('link', { name: /: Unlock \d+$/ })
  .map((link) => link.getAttribute('aria-label')?.replace(/^.*: /, ''));

function renderList(props: Partial<ComponentProps<typeof MarketplaceBrowser>> = {}) {
  return render(
    <MarketplaceBrowser
      initialPage={createPage(4, true, 0, 4)}
      initialFilters={INITIAL_FILTERS}
      sourceToolOptions={[]}
      {...props}
    />,
  );
}

describe('MarketplaceBrowser asks for its next page as the reader nears its end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    placeWindowAt(0);
    Object.assign(authState, { session: null, user: null, isLoading: false });
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    placeWindowAt(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('once the reader has scrolled, and for each next page as the end comes near again, never before', async () => {
    const end = stubListEnd({ inReach: true });
    const fetchMock = vi.fn(answerEachPage(end, 28));
    vi.stubGlobal('fetch', fetchMock);
    renderList();

    // The list's end is within reach on the first screen: still nothing is asked for until the
    // reader scrolls.
    await advance(1_000);
    expect(listRequests(fetchMock)).toEqual([]);

    await readerScrolls(200);
    await advance(20);
    expect(listRequests(fetchMock)).toEqual(['/api/marketplace/resources?offset=4&limit=12']);
    // While it loads, the button, still there, says so.
    expect(screen.getByRole('button', { name: 'Loading' })).toHaveAttribute('aria-disabled', 'true');

    // The page lands below the reader and puts the end out of reach: nothing more is asked.
    await advance(200);
    expect(drawnTitles()).toHaveLength(16);
    expect(listRequests(fetchMock)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Load more recipes' })).not.toHaveAttribute('aria-disabled');

    // The reader nears the end again: the page after, from where the last one ended.
    await act(async () => end.moveEnd(true));
    await advance(200);
    expect(listRequests(fetchMock)).toEqual([
      '/api/marketplace/resources?offset=4&limit=12',
      '/api/marketplace/resources?offset=16&limit=12',
    ]);
    expect(drawnTitles()).toHaveLength(28);

    // The listing has ended: no button, and nothing more is asked for, the end in reach or not.
    expect(screen.queryByRole('button', { name: /Load more recipes|Loading/ })).not.toBeInTheDocument();
    await act(async () => end.moveEnd(false));
    await act(async () => end.moveEnd(true));
    await advance(1_000);
    expect(listRequests(fetchMock)).toHaveLength(2);
    // From Home's distance.
    expect(new Set(end.margins)).toEqual(new Set(['600px 0px']));
  });

  it('waits 2 s, then 8 s after a failed page, then leaves it to the button, which still asks', async () => {
    stubListEnd({ inReach: true });
    const fetchMock = vi.fn(() => failAfter());
    vi.stubGlobal('fetch', fetchMock);
    renderList({ scrolledOnOpen: true });

    await advance(1_500);
    expect(listRequests(fetchMock)).toHaveLength(1);
    expect(screen.getByText('Could not load more recipes.')).toBeInTheDocument();

    await advance(1_000);
    expect(listRequests(fetchMock)).toHaveLength(2);

    await advance(8_100);
    expect(listRequests(fetchMock)).toHaveLength(3);

    // The end in reach the whole time, and nothing more is asked for by itself.
    await advance(120_000);
    expect(listRequests(fetchMock)).toHaveLength(3);
    expect(screen.getByText('Could not load more recipes.')).toBeInTheDocument();

    // The reader can always ask again.
    fetchMock.mockImplementation(async () => answer(createPage(12, false, 4, 12)));
    const button = screen.getByRole('button', { name: 'Load more recipes' });
    expect(button).not.toHaveAttribute('aria-disabled');
    await act(async () => {
      fireEvent.click(button);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(listRequests(fetchMock)).toEqual(Array(4).fill('/api/marketplace/resources?offset=4&limit=12'));
    expect(screen.getByText('Unlock 16')).toBeInTheDocument();
    expect(screen.queryByText('Could not load more recipes.')).not.toBeInTheDocument();
  });

  it('starts over after a page loads: the next failure waits the first delay again', async () => {
    stubListEnd({ inReach: true });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 2 ? answer(createPage(12, true, 4, 12)) : failAfter();
    });
    vi.stubGlobal('fetch', fetchMock);
    renderList({ scrolledOnOpen: true });

    await advance(100);
    expect(listRequests(fetchMock)).toHaveLength(1);
    // The retry after 2 s loads a page; the end still in reach, the next page is asked for at once.
    await advance(2_100);
    expect(listRequests(fetchMock)).toHaveLength(3);
    expect(listRequests(fetchMock)[2]).toBe('/api/marketplace/resources?offset=16&limit=12');
    // That one fails: the wait is the first one again (2 s), not the second (8 s).
    await advance(1_600);
    expect(listRequests(fetchMock)).toHaveLength(3);
    await advance(800);
    expect(listRequests(fetchMock)).toHaveLength(4);
  });

  it('asks again when the network comes back after the retries ran out, with its retries anew', async () => {
    stubListEnd({ inReach: true });
    const fetchMock = vi.fn(() => failAfter());
    vi.stubGlobal('fetch', fetchMock);
    renderList({ scrolledOnOpen: true });

    await advance(12_000);
    expect(listRequests(fetchMock)).toHaveLength(3);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await advance(100);
    expect(listRequests(fetchMock)).toHaveLength(4);
    // And it waits 2 s again after that one fails, not a press.
    await advance(2_100);
    expect(listRequests(fetchMock)).toHaveLength(5);
  });

  // React's development double effect runs the list's effects twice as it mounts: it still sends one
  // request, never a second that would cut the first one short (the E2E server runs this mode).
  it('asks once, in the development double render too', async () => {
    stubListEnd({ inReach: true });
    const fetchMock = vi.fn((): Promise<Response> => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StrictMode>
        <MarketplaceBrowser
          initialPage={createPage(4, true, 0, 4)}
          initialFilters={INITIAL_FILTERS}
          sourceToolOptions={[]}
          scrolledOnOpen
        />
      </StrictMode>,
    );
    await advance(500);

    expect(listRequests(fetchMock)).toEqual(['/api/marketplace/resources?offset=4&limit=12']);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal?.aborted).toBe(false);
  });

  // The button is the way for a keyboard, and a press asks for one page: what comes after it waits
  // for the reader to scroll, as the first screen does.
  it('takes a press for one page, and asks for the next only once the reader scrolls', async () => {
    const end = stubListEnd({ inReach: true });
    const fetchMock = vi.fn(answerEachPage(end));
    vi.stubGlobal('fetch', fetchMock);
    renderList();

    fireEvent.click(screen.getByRole('button', { name: 'Load more recipes' }));
    expect(screen.getByRole('button', { name: 'Loading' })).toHaveAttribute('aria-disabled', 'true');
    await advance(1_000);
    expect(listRequests(fetchMock)).toEqual(['/api/marketplace/resources?offset=4&limit=12']);
    expect(drawnTitles()).toHaveLength(16);

    await readerScrolls(300);
    await act(async () => end.moveEnd(true));
    await advance(100);
    expect(listRequests(fetchMock)).toEqual([
      '/api/marketplace/resources?offset=4&limit=12',
      '/api/marketplace/resources?offset=16&limit=12',
    ]);
  });

  // Back from a recipe draws the pages kept for the listing, in the browser's order (review of
  // #888): React draws it and runs its effects inside the popstate, at the post page's place (its
  // top), and only then does the browser put the reader back where they were. That jump is no scroll
  // of theirs, and the next page waits for one.
  it('asks for nothing on Back to a kept listing until the reader scrolls it', async () => {
    rememberMarketplacePages(buildMarketplacePagesKey(LISTING, null), 4, createPage(16, true, 0, 12));
    const end = stubListEnd({ inReach: true });
    const fetchMock = vi.fn(answerEachPage(end));
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    expect(drawnTitles()).toHaveLength(16);
    await windowMovesTo(1_800);
    await advance(1_000);
    expect(listRequests(fetchMock)).toEqual([]);
    expect(drawnTitles()).toHaveLength(16);

    await readerScrolls(120);
    await advance(200);
    expect(listRequests(fetchMock)).toEqual(['/api/marketplace/resources?offset=16&limit=12']);
    expect(drawnTitles()).toHaveLength(28);
  });

  // A filter picked in place draws another listing's first page, a first screen of its own.
  it('waits for the reader to scroll a listing picked in place', async () => {
    const end = stubListEnd({ inReach: true });
    const fetchMock = vi.fn(answerEachPage(end));
    vi.stubGlobal('fetch', fetchMock);
    const view = renderList({ scrolledOnOpen: true, onNavigate: vi.fn() });
    await advance(200);
    expect(listRequests(fetchMock)).toEqual(['/api/marketplace/resources?offset=4&limit=12']);

    const paid = { ...INITIAL_FILTERS, access: 'paid' as const };
    view.rerender(
      <MarketplaceBrowser
        initialPage={createPage(4, true, 0, 4)}
        initialFilters={paid}
        sourceToolOptions={[]}
        scrolledOnOpen
        onNavigate={vi.fn()}
      />,
    );
    // Its own place, kept by the browser for that entry, put back as Back or Forward would.
    await windowMovesTo(900);
    await act(async () => end.moveEnd(true));
    await advance(1_000);
    expect(listRequests(fetchMock)).toHaveLength(1);

    await readerScrolls(80);
    await advance(200);
    expect(listRequests(fetchMock)).toEqual([
      '/api/marketplace/resources?offset=4&limit=12',
      '/api/marketplace/resources?access=paid&offset=4&limit=12',
    ]);
  });

  // Review of #888: Back keeps a listing of the first page and ten more; one longer came back at its
  // first page alone, and the browser put the reader on that short page. By itself, the list asks
  // only for pages Back will keep; the button goes on past them, as before.
  it('asks by itself only for pages the listing can keep for Back, and leaves the rest to the button', async () => {
    stubListEnd({ inReach: true });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input), 'http://localhost').searchParams.get('offset'));
      return answer(createPage(12, true, offset, 12));
    });
    vi.stubGlobal('fetch', fetchMock);
    const kept = MARKETPLACE_PAGES_MEMORY_MAX_ITEMS - 12;
    renderList({ initialPage: createPage(kept, true, 0, kept), scrolledOnOpen: true });

    await advance(200);
    expect(listRequests(fetchMock)).toEqual([`/api/marketplace/resources?offset=${kept}&limit=12`]);
    expect(drawnTitles()).toHaveLength(MARKETPLACE_PAGES_MEMORY_MAX_ITEMS);
    expect(recallMarketplacePages(buildMarketplacePagesKey(LISTING, null))?.items).toHaveLength(MARKETPLACE_PAGES_MEMORY_MAX_ITEMS);

    // The end still in reach, and nothing more is asked for by itself.
    await advance(3_000);
    expect(listRequests(fetchMock)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Load more recipes' }));
    await advance(200);
    expect(listRequests(fetchMock)).toEqual([
      `/api/marketplace/resources?offset=${kept}&limit=12`,
      `/api/marketplace/resources?offset=${MARKETPLACE_PAGES_MEMORY_MAX_ITEMS}&limit=12`,
    ]);
    expect(drawnTitles()).toHaveLength(MARKETPLACE_PAGES_MEMORY_MAX_ITEMS + 12);
  });

  // Review of #888: a page asked for by itself set disabled on the button, which may hold the
  // keyboard's focus. It says it is busy with aria-disabled, keeps the focus, and takes no press.
  it('keeps the keyboard on the button while a page it did not ask for loads', async () => {
    const end = stubListEnd({ inReach: false });
    const fetchMock = vi.fn(answerEachPage(end));
    vi.stubGlobal('fetch', fetchMock);
    renderList({ scrolledOnOpen: true });
    const button = screen.getByRole('button', { name: 'Load more recipes' });
    act(() => button.focus());

    await act(async () => end.moveEnd(true));
    await advance(20);
    expect(listRequests(fetchMock)).toHaveLength(1);
    expect(button).toHaveAccessibleName('Loading');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toHaveAttribute('disabled');
    expect(button).toHaveFocus();

    fireEvent.click(button);
    await advance(200);
    expect(listRequests(fetchMock)).toHaveLength(1);
    expect(button).toHaveAccessibleName('Load more recipes');
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).toHaveFocus();
  });

  // The browser may still deliver a notice it queued before the observer was let go: one for a
  // listing the reader has just left would ask for the new listing's next page unscrolled.
  it('acts on no notice queued for a listing the reader has left', async () => {
    const end = stubListEnd({ inReach: true, holdNotices: true });
    const fetchMock = vi.fn(answerEachPage(end));
    vi.stubGlobal('fetch', fetchMock);
    const view = renderList({ scrolledOnOpen: true, onNavigate: vi.fn() });
    await advance(20);

    // Its first notice is queued for the next frame; a filter is picked before it comes.
    view.rerender(
      <MarketplaceBrowser
        initialPage={createPage(4, true, 0, 4)}
        initialFilters={{ ...INITIAL_FILTERS, access: 'paid' }}
        sourceToolOptions={[]}
        scrolledOnOpen
        onNavigate={vi.fn()}
      />,
    );
    await act(async () => end.deliverHeldNotices());
    await advance(1_000);
    expect(listRequests(fetchMock)).toEqual([]);
  });

  // Signed in, the listing's own first page (the reader's blocks taken out) lands after the cached
  // one and starts the list again, which cuts short a page asked for meanwhile: it is asked for
  // again once, from the new start, never twice and never lost.
  it("asks once more from the new start for a page the listing's own first page cut short", async () => {
    stubListEnd({ inReach: true });
    const answers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      answers.push(resolve);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const cachedPage = createPage(4, true, 0, 4);
    const readersPage = { ...cachedPage, items: cachedPage.items.filter((item) => item.title !== 'Unlock 2') };
    const view = renderList({ initialPage: cachedPage, scrolledOnOpen: true });
    await advance(100);
    expect(listRequests(fetchMock)).toHaveLength(1);
    const firstSignal = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal;

    view.rerender(
      <MarketplaceBrowser initialPage={readersPage} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} scrolledOnOpen />,
    );
    await advance(200);
    expect(firstSignal?.aborted).toBe(true);
    expect(listRequests(fetchMock)).toEqual(Array(2).fill('/api/marketplace/resources?offset=4&limit=12'));

    await act(async () => {
      answers[1](answer(createPage(12, false, 4, 12)));
    });
    await advance(200);
    expect(drawnTitles()).toEqual(['Unlock 1', 'Unlock 3', 'Unlock 4', ...Array.from({ length: 12 }, (_, index) => `Unlock ${index + 5}`)]);
    expect(listRequests(fetchMock)).toHaveLength(2);
  });
});
