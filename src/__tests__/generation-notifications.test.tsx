import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import GenerationNotifications from '@/components/GenerationNotifications';
import { announceGenerationSettledOnPage } from '@/lib/generation-status-client';

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

    // A creator that showed its run end (Done, It didn't finish) says so: its toast would only say
    // it again, rising over the creator's Publish just as the page offered it (2026-10-30).
    describe('a run its own page showed ending', () => {
      it('says nothing of it at the next sync', async () => {
        vi.mocked(fetch)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ generations: [statusRecord('processing')] }) } as Response)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ generations: [statusRecord('succeeded')] }) } as Response);
        const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
        render(<GenerationNotifications />);
        await waitFor(() => {
          expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
        });

        act(() => announceGenerationSettledOnPage({ id: 'gen-status-1', status: 'succeeded' }));
        const scheduledPoll = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 30000)?.[0];
        await act(async () => {
          (scheduledPoll as () => void)();
        });
        await waitFor(() => {
          expect(fetch).toHaveBeenCalledTimes(2);
        });

        expect(screen.queryByText(/ready$/i)).not.toBeInTheDocument();
        expect(screen.queryByTestId('generation-notifications')).not.toBeInTheDocument();
      });

      it('takes away a toast already up for it', async () => {
        await pollThrough('processing', 'failed');
        expect(await screen.findByText(/failed$/i)).toBeInTheDocument();

        act(() => announceGenerationSettledOnPage({ id: 'gen-status-1', status: 'failed' }));

        expect(screen.queryByText(/failed$/i)).not.toBeInTheDocument();
      });

      it('leaves the toasts of other runs alone', async () => {
        await pollThrough('processing', 'succeeded');
        expect(await screen.findByText(/ready$/i)).toBeInTheDocument();

        act(() => announceGenerationSettledOnPage({ id: 'gen-another', status: 'succeeded' }));

        expect(screen.getByText(/ready$/i)).toBeInTheDocument();
      });
    });
  });
});
