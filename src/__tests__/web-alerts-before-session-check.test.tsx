import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NotificationsPage from '@/app/notifications/page';
import { SignedInAlertsActions } from '@/app/notifications/SignedInAlerts';

// After a click on Alerts the page drew its heading over an empty body, a
// spinner, until the session check and the list's read had answered, and then
// the whole list at once; Mark all read was drawn before any count was read
// (live, 2026-11-17). Before the check the page now draws what the browser's
// session cookie says the check will find, both shapes where no cookie can be
// read yet (the server's HTML and its hydration), as the top bar's account
// slot does. tests/e2e/alerts-loading-list.spec.ts holds what a browser draws.

const mocks = vi.hoisted(() => ({
  hasReadCookie: true,
  holdsSessionCookie: true,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock('@/components/useUnreadAlertsCount', () => ({ publishUnreadAlertsCount: vi.fn() }));
vi.mock('@/components/useSupabaseAuthCookieHint', () => ({
  useHasHydratedSupabaseAuthCookieHint: () => mocks.hasReadCookie,
  useSupabaseAuthCookieHint: () => mocks.holdsSessionCookie,
}));
// The session check never answers here: what is drawn is what comes before it.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => new Promise(() => undefined),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  },
}));

const placeholderRows = () => document.querySelectorAll('[data-alerts-placeholder-row]');

describe('Alerts before the session check', () => {
  beforeEach(() => {
    mocks.hasReadCookie = true;
    mocks.holdsSessionCookie = true;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("draws the list's place and the controls' outlines for a browser that holds a session", () => {
    render(<NotificationsPage />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading alerts');
    expect(placeholderRows()).toHaveLength(6);
    for (const row of placeholderRows()) expect(row.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByTestId('alerts-actions-placeholder')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('alerts-actions-placeholder')).not.toHaveClass('app-shell-when-signed-in');
    // Drawn, never offered: nothing can be pressed before a count is read.
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
    expect(screen.queryByText('Sign in required')).not.toBeInTheDocument();
  });

  it('draws the sign-in card from the first render for a browser with no session', () => {
    mocks.holdsSessionCookie = false;
    render(<NotificationsPage />);

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnUrl=/notifications');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(placeholderRows()).toHaveLength(0);
    expect(screen.queryByTestId('alerts-actions-placeholder')).not.toBeInTheDocument();
  });

  it("draws both shapes where no cookie can be read yet, each behind the root element's mark", () => {
    mocks.hasReadCookie = false;
    render(<NotificationsPage />);

    expect(screen.getByText('Sign in required').closest('.app-shell-when-signed-out')).not.toBeNull();
    expect(screen.getByText('Sign in required').closest('.app-shell-when-signed-in')).toBeNull();
    expect(placeholderRows()[0].closest('.app-shell-when-signed-in')).not.toBeNull();
    expect(screen.getByTestId('alerts-actions-placeholder')).toHaveClass('app-shell-when-signed-in');
  });
});

describe('Mark all read', () => {
  afterEach(cleanup);

  const markAll = () => screen.getByRole('button', { name: 'Mark all read' });
  const draw = (unreadCount: number | null, isMarkingAll = false) => render(
    <SignedInAlertsActions unreadCount={unreadCount} isMarkingAll={isMarkingAll} onRefresh={vi.fn()} onMarkAllRead={vi.fn()} />
  );

  // It was drawn at 40% opacity and lit up under a pointer, from before the
  // count was known and with nothing unread.
  it('is off, and drawn as its outline is, with no count read or nothing unread', () => {
    for (const unreadCount of [null, 0]) {
      const { unmount } = draw(unreadCount);
      expect(markAll()).toBeDisabled();
      expect(markAll()).toHaveClass('bg-transparent', 'text-[var(--ui-text-faint)]');
      expect(markAll().className).not.toMatch(/hover:/);
      unmount();
    }
  });

  it('is on offer with something unread, and only answers a pointer then', () => {
    draw(3);
    expect(markAll()).toBeEnabled();
    expect(markAll()).toHaveClass('bg-[var(--ui-surface-2)]', 'enabled:hover:bg-[var(--ui-surface-3)]');
  });

  it('keeps its look, with a spinner, while the write is under way', () => {
    draw(3, true);
    expect(markAll()).toBeDisabled();
    expect(markAll()).toHaveClass('bg-[var(--ui-surface-2)]');
  });
});
