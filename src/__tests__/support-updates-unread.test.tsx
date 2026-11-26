import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SUPPORT_UPDATES_LATEST_SESSION_KEY,
  markSupportUpdatesSeen,
  noteSupportUpdatesLatest,
  requestSupportUpdatesLatest,
  resetSupportUpdatesUnreadForTests,
  useSupportUpdatesUnread,
} from '@/lib/support-updates-unread';

import { SUPPORT_UPDATES_SEEN_STORAGE_KEY } from '../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

const SUPABASE_URL = 'https://project-ref.supabase.co';
const AUTH_COOKIE = 'sb-project-ref-auth-token';
const NEWEST = '2026-11-26T12:00:00.000Z';

function page(latestAt: string | null) {
  return new Response(JSON.stringify({ updates: [], nextCursor: null, latestAt }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function Dot({ enabled = true }: { enabled?: boolean }) {
  return <p>{useSupportUpdatesUnread(enabled) ? 'dot' : 'no dot'}</p>;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetSupportUpdatesUnreadForTests();
});

afterEach(() => {
  document.cookie = `${AUTH_COOKIE}=; Max-Age=0; Path=/`;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetSupportUpdatesUnreadForTests();
});

describe("Help & Support's unread dot", () => {
  it('asks when the newest update was published once a browser session, through the shared read without a session cookie', async () => {
    const fetcher = vi.fn(async () => page(NEWEST));
    render(<Dot />);

    await act(async () => {
      requestSupportUpdatesLatest(fetcher);
      requestSupportUpdatesLatest(fetcher);
    });
    expect(fetcher.mock.calls).toEqual([['/api/support/updates?limit=1&scope=public']]);
    expect(screen.getByText('dot')).toBeInTheDocument();
    expect(JSON.parse(window.sessionStorage.getItem(SUPPORT_UPDATES_LATEST_SESSION_KEY) ?? 'null')).toEqual({ latestAt: NEWEST });

    // The next page of the visit (a new document of the same tab) reads it from the tab.
    resetSupportUpdatesUnreadForTests();
    const nextPage = vi.fn(async () => page(NEWEST));
    await act(async () => requestSupportUpdatesLatest(nextPage));
    expect(nextPage).not.toHaveBeenCalled();
    expect(screen.getByText('dot')).toBeInTheDocument();
  });

  it('asks without the shared scope, and without a token, in a browser with a session cookie', async () => {
    document.cookie = `${AUTH_COOKIE}=session; Path=/`;
    const fetcher = vi.fn<typeof fetch>(async () => page(NEWEST));

    await act(async () => requestSupportUpdatesLatest(fetcher));
    expect(fetcher.mock.calls).toEqual([['/api/support/updates?limit=1']]);
  });

  it('draws no dot when nothing is published, when the read fails, or once the newest update is seen', async () => {
    render(<Dot />);
    await act(async () => requestSupportUpdatesLatest(vi.fn(async () => page(null))));
    expect(screen.getByText('no dot')).toBeInTheDocument();

    resetSupportUpdatesUnreadForTests();
    window.sessionStorage.clear();
    await act(async () => requestSupportUpdatesLatest(vi.fn(async () => new Response('{}', { status: 503 }))));
    expect(screen.getByText('no dot')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(SUPPORT_UPDATES_LATEST_SESSION_KEY)).toBeNull();

    resetSupportUpdatesUnreadForTests();
    await act(async () => requestSupportUpdatesLatest(vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    })));
    expect(screen.getByText('no dot')).toBeInTheDocument();

    act(() => noteSupportUpdatesLatest(NEWEST));
    expect(screen.getByText('dot')).toBeInTheDocument();
    act(() => markSupportUpdatesSeen(NEWEST));
    expect(screen.getByText('no dot')).toBeInTheDocument();
    expect(window.localStorage.getItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY)).toBe(NEWEST);
  });

  it('keeps the latest look, never an earlier one', () => {
    window.localStorage.setItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY, NEWEST);
    markSupportUpdatesSeen('2026-11-01T00:00:00.000Z');
    expect(window.localStorage.getItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY)).toBe(NEWEST);

    markSupportUpdatesSeen('2026-11-30T00:00:00.000Z');
    expect(window.localStorage.getItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY)).toBe('2026-11-30T00:00:00.000Z');
  });

  it("follows another tab's look at Updates", () => {
    window.localStorage.setItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY, '2026-11-01T00:00:00.000Z');
    noteSupportUpdatesLatest(NEWEST);
    render(<Dot />);
    expect(screen.getByText('dot')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SUPPORT_UPDATES_SEEN_STORAGE_KEY, newValue: NEWEST }));
    });
    expect(screen.getByText('no dot')).toBeInTheDocument();
  });

  it('asks once the browser is idle, and not at all where it is switched off', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => page(NEWEST));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(<Dot enabled={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('no dot')).toBeInTheDocument();
    unmount();

    render(<Dot />);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock.mock.calls).toEqual([['/api/support/updates?limit=1&scope=public']]);
    expect(screen.getByText('dot')).toBeInTheDocument();
  });

  it('reads storage that cannot be read as empty', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      render(<Dot />);
      expect(screen.getByText('no dot')).toBeInTheDocument();
      act(() => noteSupportUpdatesLatest(NEWEST));
      expect(screen.getByText('dot')).toBeInTheDocument();
      act(() => markSupportUpdatesSeen(NEWEST));
      expect(screen.getByText('no dot')).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
