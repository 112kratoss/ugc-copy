import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NotificationsPage from '@/app/notifications/page';

// Refresh and Mark all read and the list are two lazily loaded parts of one
// module (SignedInAlerts.tsx). With an import() each, the two loads could part:
// the first fail on a flaky connection and the second, asked for a moment later,
// succeed (a failed chunk is asked for again by the next import()), and the list
// drew without its controls, with no card to say so, until a reload. They share
// one load now: when it fails, it fails for both, and the page's card says so.

type TestSession = { access_token: string } | null;

const mocks = vi.hoisted(() => ({
  session: { access_token: 'viewer-token' } as TestSession,
  signedInHalfLoads: 0,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock('@/components/useUnreadAlertsCount', () => ({ publishUnreadAlertsCount: vi.fn() }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: mocks.session } }),
      onAuthStateChange: (listener: (event: string, session: TestSession) => void) => {
        queueMicrotask(() => listener('INITIAL_SESSION', mocks.session));
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
    },
  },
}));
// The app directory's next/dynamic, as the bundler serves it, with the page's
// own loaders (web-alerts-signed-in-half-failure.test.tsx says why vitest's
// own resolution would hide a failed load).
vi.mock('next/dynamic', async () => {
  const { default: appDynamic } = await import('next/dist/api/app-dynamic');
  return { default: appDynamic };
});
// The first load of the module fails, as a chunk request on a flaky connection
// does; a load asked for after it would succeed.
vi.mock('@/app/notifications/SignedInAlerts', async (importOriginal) => {
  mocks.signedInHalfLoads += 1;
  if (mocks.signedInHalfLoads === 1) throw new Error('Loading chunk SignedInAlerts failed.');
  return importOriginal();
});

describe('the web Alerts page when the first load of its signed-in half fails', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('reportError', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, notifications: [], unreadCount: 0 }),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    consoleError.mockRestore();
  });

  it('fails the controls and the list together: one card, and neither part drawn or still loading', async () => {
    render(<NotificationsPage />);

    expect(await screen.findByRole('heading', { name: 'Could not load alerts' })).toBeInTheDocument();
    // Turns enough for a second load to land, had either part asked for one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(mocks.signedInHalfLoads).toBe(1);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
    expect(screen.queryByText('You are all caught up')).toBeNull();
    // The controls' part has settled too: its boundary draws nothing in their place.
    expect(screen.queryByTestId('alerts-actions-placeholder')).toBeNull();
  });
});
