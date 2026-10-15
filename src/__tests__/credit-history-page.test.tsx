import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreditHistoryClient from '@/app/credits/CreditHistoryClient';
import {
  CREDIT_HISTORY_PAGE_SIZE,
  appendCreditHistoryPage,
  creditHistoryUrl,
  formatCreditBalance,
  formatCreditChange,
  formatCreditHistoryTime,
  parseCreditHistoryPage,
  type CreditHistoryEntry,
} from '@/app/credits/credit-history';
import { RequireAuth } from '@/components/RouteAuthBoundary';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getServerAuthState: vi.fn(),
  auth: { credits: 1295 as number | null },
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ credits: mocks.auth.credits }),
  AuthProvider: ({ children, initialSession }: { children: ReactNode; initialSession?: unknown }) => (
    <div data-testid="auth-provider" data-signed-in={String(Boolean(initialSession))}>{children}</div>
  ),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => mocks.getServerAuthState(),
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One C4 entry: `GET /api/credits/history` answers `{ entries, nextCursor }`, newest first. */
function entry(overrides: Partial<CreditHistoryEntry> & { id: string }): CreditHistoryEntry {
  return {
    kind: 'spend',
    amount: -40,
    occurredAt: '2026-10-15T10:00:00.000Z',
    title: 'Video generation',
    detail: null,
    ...overrides,
  };
}

const FIRST_PAGE = {
  entries: [
    entry({ id: 'spend:gen-2', amount: -120, occurredAt: '2026-10-15T12:30:00.000Z', title: 'Video generation', detail: 'Kling 2.5 · 10 s' }),
    entry({ id: 'refund:gen-1', kind: 'refund', amount: 40, occurredAt: '2026-10-15T09:10:00.000Z', title: 'Refund: failed video' }),
    entry({ id: 'purchase:order-1', kind: 'purchase', amount: 1500, occurredAt: '2026-10-14T08:00:00.000Z', title: 'Creator pack' }),
  ],
  nextCursor: 'cursor-page-2',
};

const SECOND_PAGE = {
  entries: [
    // Already listed: a page boundary may repeat a row, and it is shown once.
    entry({ id: 'purchase:order-1', kind: 'purchase', amount: 1500, occurredAt: '2026-10-14T08:00:00.000Z', title: 'Creator pack' }),
    entry({ id: 'grant:welcome', kind: 'grant', amount: 100, occurredAt: '2026-10-01T08:00:00.000Z', title: 'Welcome credits' }),
    entry({ id: 'reversal:order-0', kind: 'reversal', amount: -500, occurredAt: '2026-09-30T08:00:00.000Z', title: 'Purchase refunded' }),
  ],
  nextCursor: null,
};

function requestedUrls() {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url), 'https://magicbooklet.test'));
}

function activityRows() {
  return within(screen.getByRole('list', { name: 'Credit activity, newest first' })).getAllByRole('listitem');
}

describe('credit history page', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    mocks.getSession.mockReset();
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'fresh-token' } } });
    mocks.auth.credits = 1295;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the newest page with the server words, signed amounts and the balance', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(FIRST_PAGE));

    render(<CreditHistoryClient />);

    expect(screen.getByRole('status', { name: 'Loading your credit history' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Credit history' })).toBeInTheDocument();
    expect(screen.getByText('1,295 credits')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get credits' })).toHaveAttribute('href', '/pricing');

    await screen.findByText('Video generation');
    const rows = activityRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Video generation');
    expect(rows[0]).toHaveTextContent('Kling 2.5 · 10 s');
    expect(rows[0]).toHaveTextContent('−120 credits');
    expect(rows[1]).toHaveTextContent('Refund: failed video');
    expect(rows[1]).toHaveTextContent('+40 credits');
    expect(rows[2]).toHaveTextContent('Creator pack');
    expect(rows[2]).toHaveTextContent('+1,500 credits');
    const time = within(rows[2]).getByText(formatCreditHistoryTime('2026-10-14T08:00:00.000Z')!);
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', '2026-10-14T08:00:00.000Z');

    // The bearer token is the session's own, read for this request, and the
    // first page carries no cursor.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = requestedUrls();
    expect(url.pathname).toBe('/api/credits/history');
    expect(url.searchParams.get('cursor')).toBeNull();
    expect(url.searchParams.get('limit')).toBe(String(CREDIT_HISTORY_PAGE_SIZE));
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer fresh-token' } });
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('loads older pages with the cursor, shows each entry once and stops at the end', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(FIRST_PAGE))
      .mockResolvedValueOnce(jsonResponse(SECOND_PAGE));

    render(<CreditHistoryClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    // Not the end while there is an older page to read.
    expect(screen.queryByText('Your credit history starts here.')).not.toBeInTheDocument();

    expect(await screen.findByText('Welcome credits')).toBeInTheDocument();
    const rows = activityRows();
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Video generation'),
      expect.stringContaining('Refund: failed video'),
      expect.stringContaining('Creator pack'),
      expect.stringContaining('Welcome credits'),
      expect.stringContaining('Purchase refunded'),
    ]);
    expect(rows[4]).toHaveTextContent('−500 credits');
    expect(requestedUrls()[1].searchParams.get('cursor')).toBe('cursor-page-2');
    expect(requestedUrls()[1].searchParams.get('limit')).toBe(String(CREDIT_HISTORY_PAGE_SIZE));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByText('Your credit history starts here.')).toBeInTheDocument();
    // Counted as listed: the repeated row is not news.
    expect(screen.getByText('Loaded 2 older entries.')).toBeInTheDocument();
  });

  it('says so when there is no credit activity yet', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [], nextCursor: null }));

    render(<CreditHistoryClient />);

    expect(await screen.findByRole('heading', { name: 'No credit activity yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start creating' })).toHaveAttribute('href', '/create');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows the server error with a retry that reads the newest page again', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Credit history is busy. Try again shortly.' }, 503))
      .mockResolvedValueOnce(jsonResponse(FIRST_PAGE));

    render(<CreditHistoryClient />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your credit history');
    expect(alert).toHaveTextContent('Credit history is busy. Try again shortly.');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Creator pack')).toBeInTheDocument();
    expect(requestedUrls()[1].searchParams.get('cursor')).toBeNull();
    expect(screen.queryByText('Could not load your credit history')).not.toBeInTheDocument();
  });

  it('falls back to a connection hint when the request never reaches the server', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    render(<CreditHistoryClient />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your credits are safe. Check your connection, then try again.');
  });

  it('treats an answer of another shape as a failure, not as an empty history', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    render(<CreditHistoryClient />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your credit history');
    expect(screen.queryByText('No credit activity yet')).not.toBeInTheDocument();
  });

  it('asks a browser whose session ended to sign in again, and does not call the API without one', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } });

    render(<CreditHistoryClient />);

    expect(await screen.findByText('Sign in again to see your credit history')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnUrl=/credits');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads an Auth server it cannot reach as a connection problem, not as a sign-out', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: null },
      error: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }),
    });

    render(<CreditHistoryClient />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your credits are safe. Check your connection, then try again.');
    expect(screen.queryByText('Sign in again to see your credit history')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks to sign in again when the server no longer takes the session', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));

    render(<CreditHistoryClient />);

    expect(await screen.findByText('Sign in again to see your credit history')).toBeInTheDocument();
  });

  it('keeps the listed rows when an older page fails, and Load more tries again', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(FIRST_PAGE))
      .mockResolvedValueOnce(jsonResponse({ error: 'Server error' }, 500))
      .mockResolvedValueOnce(jsonResponse(SECOND_PAGE));

    render(<CreditHistoryClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Older activity could not be loaded. Check your connection, then try again.')).toBeInTheDocument();
    expect(activityRows()).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Purchase refunded')).toBeInTheDocument();
    expect(requestedUrls()[2].searchParams.get('cursor')).toBe('cursor-page-2');
    expect(screen.queryByText(/Older activity could not be loaded/)).not.toBeInTheDocument();
  });

  it('reloads from the newest when the server refuses the cursor of an older page', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(FIRST_PAGE))
      .mockResolvedValueOnce(jsonResponse({ error: 'Invalid cursor' }, 400))
      .mockResolvedValueOnce(jsonResponse({ entries: [FIRST_PAGE.entries[2]], nextCursor: null }));

    render(<CreditHistoryClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Your credit history changed since it was opened. Reload it from the newest.')).toBeInTheDocument();
    // A retry with the same cursor would be refused again.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reload from the newest' }));
    await waitFor(() => expect(activityRows()).toHaveLength(1));
    expect(requestedUrls()[2].searchParams.get('cursor')).toBeNull();
  });

  it('refreshes from the newest page, and keeps the list when a refresh cannot be read', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(FIRST_PAGE))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({
        entries: [entry({ id: 'spend:gen-3', amount: -60, title: 'Image generation' }), ...FIRST_PAGE.entries],
        nextCursor: 'cursor-page-2b',
      }));

    render(<CreditHistoryClient />);
    await screen.findByText('Creator pack');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh credit history' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not refresh your credit history');
    expect(alert).toHaveTextContent('This is what loaded before. Check your connection, then try again.');
    expect(activityRows()).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh credit history' }));
    expect(await screen.findByText('Image generation')).toBeInTheDocument();
    expect(activityRows()).toHaveLength(4);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads the newest page again when the balance moves, while only that page is listed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(FIRST_PAGE))
      .mockResolvedValueOnce(jsonResponse({
        entries: [entry({ id: 'purchase:order-2', kind: 'purchase', amount: 3000, title: 'Pro pack' }), ...FIRST_PAGE.entries],
        nextCursor: 'cursor-page-2',
      }))
      .mockResolvedValueOnce(jsonResponse(SECOND_PAGE));

    render(<CreditHistoryClient />);
    await screen.findByText('Creator pack');

    await act(async () => {
      window.dispatchEvent(new Event('credits_updated'));
    });
    expect(await screen.findByText('Pro pack')).toBeInTheDocument();
    expect(requestedUrls()[1].searchParams.get('cursor')).toBeNull();

    // Once older activity is listed, a balance change leaves the list alone.
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Welcome credits');
    await act(async () => {
      window.dispatchEvent(new Event('credits_updated'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('lets a Load more asked for while the newest page is being read again win over that read', async () => {
    let releaseQuietRead: (response: Response) => void = () => undefined;
    let releaseOlderPage: (response: Response) => void = () => undefined;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(FIRST_PAGE))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseQuietRead = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseOlderPage = resolve; }));

    render(<CreditHistoryClient />);
    await screen.findByText('Creator pack');
    await act(async () => {
      window.dispatchEvent(new Event('credits_updated'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // The newest page answers first, while the older page is still out: the
    // list stays as the reader asked for it to be extended.
    await act(async () => {
      releaseQuietRead(jsonResponse({ entries: [entry({ id: 'purchase:order-2', kind: 'purchase', amount: 3000, title: 'Pro pack' })], nextCursor: null }));
    });
    expect(screen.queryByText('Pro pack')).not.toBeInTheDocument();
    expect(activityRows()).toHaveLength(3);

    await act(async () => {
      releaseOlderPage(jsonResponse(SECOND_PAGE));
    });
    expect(await screen.findByText('Purchase refunded')).toBeInTheDocument();
    expect(activityRows()).toHaveLength(5);
    expect(screen.getByText('Loaded 2 older entries.')).toBeInTheDocument();
  });

  it("draws an unknown balance in the app's words, never as 0", async () => {
    mocks.auth.credits = null;
    fetchMock.mockResolvedValueOnce(jsonResponse(FIRST_PAGE));

    render(<CreditHistoryClient />);

    expect(screen.getByText('Balance loading…')).toBeInTheDocument();
    expect(screen.queryByText(/^0 credits$/)).not.toBeInTheDocument();
    await screen.findByText('Creator pack');
  });

  it('shows a balance below zero as it is, so the refund that caused it can explain it', async () => {
    mocks.auth.credits = -150;
    fetchMock.mockResolvedValueOnce(jsonResponse(FIRST_PAGE));

    render(<CreditHistoryClient />);

    expect(screen.getByText('−150 credits')).toBeInTheDocument();
    await screen.findByText('Creator pack');
  });
});

describe('credit history route', () => {
  beforeEach(() => {
    mocks.redirect.mockClear();
    mocks.getServerAuthState.mockReset();
  });

  it('is kept out of search results', async () => {
    const { metadata } = await import('@/app/credits/layout');

    expect(metadata.title).toBe('Credit history');
    expect(metadata.robots).toMatchObject({ index: false, googleBot: { index: false } });
  });

  // The layout hands the page to the sign-in boundary, an async server
  // component; it is run here as the server runs it.
  async function renderBoundary() {
    const { default: CreditsLayout } = await import('@/app/credits/layout');
    const element = await CreditsLayout({ children: <p>Private page</p> });
    expect(element.type).toBe(RequireAuth);
    expect(element.props).toMatchObject({ returnTo: '/credits' });
    return RequireAuth(element.props);
  }

  it('sends a signed-out visitor to sign in and back to /credits', async () => {
    mocks.getServerAuthState.mockResolvedValue({ session: null, credits: null });

    await expect(renderBoundary()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/login?returnUrl=%2Fcredits');
    expect(decodeURIComponent(mocks.redirect.mock.calls[0][0])).toBe('/login?returnUrl=/credits');
  });

  it('draws the page for a signed-in visitor', async () => {
    mocks.getServerAuthState.mockResolvedValue({ session: { user: { id: 'user-1' } }, credits: 20 });

    render(await renderBoundary());

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-signed-in', 'true');
    expect(screen.getByText('Private page')).toBeInTheDocument();
  });
});

describe('credit history contract reading (C4)', () => {
  it('builds the request with the page size, and the cursor only for older pages', () => {
    expect(creditHistoryUrl(null)).toBe('/api/credits/history?limit=30');
    expect(creditHistoryUrl('abc/+=')).toBe('/api/credits/history?limit=30&cursor=abc%2F%2B%3D');
  });

  it('reads every kind, keeps the server words, and leaves out rows it cannot place', () => {
    const page = parseCreditHistoryPage({
      entries: [
        { id: 'a', kind: 'purchase', amount: 1500, occurredAt: '2026-10-14T08:00:00.000Z', title: 'Creator pack', detail: null },
        { id: 'b', kind: 'grant', amount: 100, occurredAt: '2026-10-14T08:00:00.000Z', title: 'Referral reward', detail: '  ' },
        { id: 'c', kind: 'refund', amount: 40, occurredAt: '2026-10-14T08:00:00.000Z', title: 'Refund: failed video', detail: 'Kling 2.5' },
        { id: 'd', kind: 'reversal', amount: -500, occurredAt: '2026-10-14T08:00:00.000Z', title: 'Purchase refunded', detail: null },
        { id: 'e', kind: 'spend', amount: -20, occurredAt: '2026-10-14T08:00:00.000Z', title: 'Recipe unlocked', detail: null },
        { id: 'f', kind: 'adjustment', amount: 5, occurredAt: '2026-10-14T08:00:00.000Z', title: '', detail: null },
        { id: 'g', kind: 'payout', amount: -5, occurredAt: '2026-10-14T08:00:00.000Z', title: 'Something new', detail: null },
        { kind: 'spend', amount: -1, title: 'No id' },
        { id: 'h', kind: 'spend', amount: 'ten', title: 'No amount' },
        null,
      ],
      nextCursor: 'next',
    });

    expect(page.nextCursor).toBe('next');
    expect(page.entries.map((item) => [item.id, item.kind, item.amount, item.title, item.detail])).toEqual([
      ['a', 'purchase', 1500, 'Creator pack', null],
      ['b', 'grant', 100, 'Referral reward', null],
      ['c', 'refund', 40, 'Refund: failed video', 'Kling 2.5'],
      ['d', 'reversal', -500, 'Purchase refunded', null],
      ['e', 'spend', -20, 'Recipe unlocked', null],
      ['f', 'adjustment', 5, 'Adjustment', null],
      // A kind the server adds later is still listed, in its own words.
      ['g', 'adjustment', -5, 'Something new', null],
    ]);
    expect(parseCreditHistoryPage({ entries: [], nextCursor: '' }).nextCursor).toBeNull();
    expect(() => parseCreditHistoryPage({ nextCursor: null })).toThrow();
    expect(() => parseCreditHistoryPage(null)).toThrow();
  });

  it('joins an older page below the listed rows, each entry once', () => {
    const listed = [entry({ id: 'a' }), entry({ id: 'b' })];
    expect(appendCreditHistoryPage(listed, [entry({ id: 'b' }), entry({ id: 'c' })]).map((item) => item.id))
      .toEqual(['a', 'b', 'c']);
  });

  it('groups credits as the app does and marks the direction of each change', () => {
    expect(formatCreditBalance(150000)).toBe('1,50,000');
    expect(formatCreditBalance(-150)).toBe('−150');
    expect(formatCreditChange(1500)).toBe('+1,500');
    expect(formatCreditChange(-120)).toBe('−120');
    expect(formatCreditChange(0)).toBe('0');
    expect(formatCreditHistoryTime('not a time')).toBeNull();
  });
});
