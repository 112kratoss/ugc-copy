import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import GenerationNotifications from '@/components/GenerationNotifications';

vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
    motion: new Proxy({}, {
      get: (_target, tag: string) => ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
        React.createElement(tag, props, children),
    }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});

let mockedPathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => mockedPathname }));

const getSessionMock = vi.fn();
const onAuthStateChangeMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: (
        callback: (_event: string, session: { access_token: string } | null) => void
      ) => onAuthStateChangeMock(callback),
    },
  },
}));

describe('GenerationNotifications', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          generations: [
            {
              id: 'gen-status-1',
              status: 'processing',
              created_at: '2026-03-24T11:00:00.000Z',
              completed_at: null,
              category: 'image',
              model: 'nano-banana-2',
            },
          ],
        }),
      }))
    );
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: 'test-token',
        },
      },
    });
    onAuthStateChangeMock.mockReturnValue({
      data: {
        subscription: {
          unsubscribe: vi.fn(),
        },
      },
    });
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it('polls the status-only generation endpoint for notification updates', async () => {
    render(<GenerationNotifications />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/generations?detail=status&limit=80', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      });
    });
  });

  it('polls only active generation ids after the initial status sync', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    render(<GenerationNotifications />);

    await waitFor(() => {
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
    });
    const scheduledPoll = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 30000)?.[0];
    expect(scheduledPoll).toBeTypeOf('function');

    await act(async () => {
      scheduledPoll?.();
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/generations?detail=status&limit=80&ids=gen-status-1',
        { headers: { Authorization: 'Bearer test-token' } },
      );
    });
  });

  it('stops background polling when the initial list has no active work', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        generations: [{
          id: 'gen-status-1',
          status: 'succeeded',
          created_at: '2026-03-24T11:00:00.000Z',
          completed_at: '2026-03-24T11:01:00.000Z',
          category: 'image',
          model: 'nano-banana-2',
        }],
      }),
    } as Response);
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    render(<GenerationNotifications />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 30000)).toBe(false);
  });

  describe('a tracked run that ends', () => {
    const statusRecord = (status: string) => ({
      id: 'gen-status-1',
      status,
      created_at: '2026-03-24T11:00:00.000Z',
      completed_at: status === 'succeeded' || status === 'failed' ? '2026-03-24T11:01:00.000Z' : null,
      category: 'image',
      model: 'nano-banana-2',
    });

    /** The first sync sees `from`, the next scheduled poll sees `to`. */
    const pollThrough = async (from: string, to: string) => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ generations: [statusRecord(from)] }) } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ generations: [statusRecord(to)] }) } as Response);
      const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
      render(<GenerationNotifications />);

      await waitFor(() => {
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
      });
      const scheduledPoll = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 30000)?.[0];
      await act(async () => {
        (scheduledPoll as () => void)();
      });
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(2);
      });
    };

    const creditsUpdated = vi.fn<(event: Event) => void>();
    beforeEach(() => {
      creditsUpdated.mockClear();
      window.addEventListener('credits_updated', creditsUpdated);
    });
    afterEach(() => {
      window.removeEventListener('credits_updated', creditsUpdated);
    });

    // A held start the reaper fails leaves `pending` for `failed` directly; it
    // used to end with no toast and with the debited balance still on screen.
    it('announces a failure from pending, asks for the balance again, and links to that run', async () => {
      await pollThrough('pending', 'failed');

      expect(await screen.findByText(/failed$/i)).toBeInTheDocument();
      expect(creditsUpdated).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('link', { name: 'View Studio' })).toHaveAttribute(
        'href',
        '/creations?generation=gen-status-1',
      );
    });

    it('announces a success from pending without touching the balance', async () => {
      await pollThrough('pending', 'succeeded');

      expect(await screen.findByText(/ready$/i)).toBeInTheDocument();
      expect(creditsUpdated).not.toHaveBeenCalled();
    });

    it('asks for the balance again when a processing run fails', async () => {
      await pollThrough('processing', 'failed');

      expect(await screen.findByText(/failed$/i)).toBeInTheDocument();
      expect(creditsUpdated).toHaveBeenCalledTimes(1);
    });

    // Below 1120px a creator is one column and its bars hold the window's foot (on a phone, with
    // no bottom navigation under them): a toast rising there covered Generate, and Publish whole.
    describe('where it comes in', () => {
      let oneColumn = false;
      beforeEach(() => {
        mockedPathname = '/';
        oneColumn = false;
        vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
          matches: query === '(max-width: 1119px)' && oneColumn,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })));
      });
      afterEach(() => {
        mockedPathname = '/';
      });

      const placement = async () => {
        await pollThrough('processing', 'succeeded');
        expect(await screen.findByText(/ready$/i)).toBeInTheDocument();
        const container = screen.getByTestId('generation-notifications');
        return container.className.includes('top-[calc(var(--app-shell-topbar-height)+0.75rem)]') ? 'under the top bar'
          : container.className.split(' ').includes('bottom-4') ? 'over the bottom edge' : 'nowhere';
      };

      it.each(['/create-image', '/create-video', '/create-motion'])('comes down from under the top bar on %s in one column', async (pathname) => {
        mockedPathname = pathname;
        oneColumn = true;
        expect(await placement()).toBe('under the top bar');
      });

      it('rises over the bottom edge beside a creator\'s two panes', async () => {
        mockedPathname = '/create-video';
        expect(await placement()).toBe('over the bottom edge');
      });

      it('rises over the bottom edge on every other page, a phone\'s included', async () => {
        mockedPathname = '/showcase';
        oneColumn = true;
        expect(await placement()).toBe('over the bottom edge');
      });
    });
  });
});
