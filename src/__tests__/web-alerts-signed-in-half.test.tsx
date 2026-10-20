import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import NotificationsPage from '@/app/notifications/page';

// The Alerts tab is in the shell of every page. Its signed-in half links
// non-public-utilities.css, so a signed-out visitor, who gets the sign-in card,
// must never load it: while the folder's layout linked the sheet, every
// signed-out click on the tab fetched it and kept it for the visit.
// route-style-readiness.test.ts holds the module to import() alone.

type TestSession = { access_token: string } | null;

const mocks = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
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
// The module itself, counted as it loads.
vi.mock('@/app/notifications/SignedInAlerts', async (importOriginal) => {
  mocks.signedInHalfLoads += 1;
  return importOriginal();
});

describe('the web Alerts page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Signed out first: the module, once loaded, stays loaded for the file.
  it('draws the sign-in card without loading the signed-in half', async () => {
    mocks.session = null;
    vi.stubGlobal('fetch', vi.fn());
    render(<NotificationsPage />);

    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnUrl=/notifications');
    // A few more turns for any import() the page might start late.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(mocks.signedInHalfLoads).toBe(0);
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });

  it('loads the signed-in half once the session check finds a reader', async () => {
    mocks.session = { access_token: 'viewer-token' };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, notifications: [], unreadCount: 0 }),
    })));
    render(<NotificationsPage />);

    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeInTheDocument();
    expect(await screen.findByText('You are all caught up')).toBeInTheDocument();
    expect(mocks.signedInHalfLoads).toBe(1);
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });
});
