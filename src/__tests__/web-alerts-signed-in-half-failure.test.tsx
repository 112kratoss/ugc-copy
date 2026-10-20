import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NotificationsPage from '@/app/notifications/page';

// The signed-in half of Alerts loads with import() once a reader is known
// (web-alerts-signed-in-half.test.tsx). That load can fail: a deploy rotated
// the chunk names while the tab was open and the reader then signed in, or the
// connection was down at that moment. React.lazy throws the failure to the
// nearest error boundary, and src/app has none, so the reader got Next's
// generic client-exception page in place of the list. The page now keeps the
// failure to the half and draws its own error card, whose Retry reloads.

type TestSession = { access_token: string } | null;

const mocks = vi.hoisted(() => ({
  session: { access_token: 'viewer-token' } as TestSession,
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
// In the app directory the bundler serves `next/dynamic` from
// next/dist/api/app-dynamic (next/dist/build/create-compiler-aliases.js), whose
// loader is React.lazy with nothing to catch a failed load. Left to itself
// vitest resolves the pages one, which catches the failure and hands it to the
// loading component, and the page would never meet the error this test is about.
// Every load the page asks for fails, as the request for a chunk whose name a
// deploy rotated does: the import() rejects. (A module mock whose factory
// throws is not steady here: a second import() of it has come back pending, and
// has come back with the real module.)
vi.mock('next/dynamic', async () => {
  const { default: appDynamic } = await import('next/dist/api/app-dynamic');
  return {
    default: (_loader: unknown, options?: Parameters<typeof appDynamic>[1]) => (
      appDynamic(() => Promise.reject(new Error('Loading chunk SignedInAlerts failed.')), options)
    ),
  };
});

describe('the web Alerts page when its signed-in half does not load', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  const reload = vi.fn();

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    reload.mockReset();
    vi.stubGlobal('location', { reload });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, notifications: [], unreadCount: 2 }),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    consoleError.mockRestore();
  });

  it("draws the page's error card, once, and Retry reloads the page", async () => {
    render(<NotificationsPage />);

    expect(await screen.findByRole('heading', { name: 'Could not load alerts' })).toBeInTheDocument();
    // The page itself stands: its heading and the count the list read answered.
    expect(screen.getByRole('heading', { name: 'Alerts' })).toBeInTheDocument();
    expect(screen.getByText('2 unread alerts')).toBeInTheDocument();
    // One card, below the header: the controls' boundary draws nothing in their place.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByText('Part of this page did not load. Retry reloads it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);

    // The failure was caught and logged, not thrown out of the page.
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to load the signed-in half of Alerts:',
      expect.objectContaining({ message: 'Loading chunk SignedInAlerts failed.' }),
    );
  });
});
