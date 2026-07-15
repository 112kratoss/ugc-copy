import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import GenerationNotifications from '@/app/components/GenerationNotifications';

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
});
