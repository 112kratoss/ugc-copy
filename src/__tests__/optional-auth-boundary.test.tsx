import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerAuthStateMock = vi.fn();
const cookieEntries: Array<{ name: string; value: string }> = [];
let hasAuthHint = false;

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('@/lib/supabase-auth-cookie', () => ({
  hasSupabaseAuthCookie: () => hasAuthHint,
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => cookieEntries,
    get: (name: string) => cookieEntries.find((entry) => entry.name === name),
  }),
}));

vi.mock('@/components/AuthProvider', () => ({
  AuthProvider: ({
    children,
    hasResolvedInitialState = false,
    initialCredits = null,
    initialMarketplaceSpendableCredits = null,
  }: {
    children: ReactNode;
    hasResolvedInitialState?: boolean;
    initialCredits?: number | null;
    initialMarketplaceSpendableCredits?: number | null;
  }) => (
    <div
      data-testid="auth-provider"
      data-resolved={String(hasResolvedInitialState)}
      data-credits={String(initialCredits)}
      data-spendable-credits={String(initialMarketplaceSpendableCredits)}
    >
      {children}
    </div>
  ),
}));

describe('OptionalAuth', () => {
  beforeEach(() => {
    getServerAuthStateMock.mockReset();
    cookieEntries.splice(0);
    hasAuthHint = false;
  });

  it('does not mount or verify auth for signed-out request-hinted routes', async () => {
    const { RequestHintedOptionalAuth } = await import('@/components/RouteAuthBoundary');

    render(await RequestHintedOptionalAuth({
      children: (
        <span>Public content</span>
      ),
    }));

    expect(screen.getByText('Public content')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-provider')).not.toBeInTheDocument();
    expect(getServerAuthStateMock).not.toHaveBeenCalled();
  });

  it('verifies hinted sessions and mounts resolved auth state', async () => {
    const { RequestHintedOptionalAuth } = await import('@/components/RouteAuthBoundary');
    hasAuthHint = true;
    getServerAuthStateMock.mockResolvedValue({ session: null, credits: null });

    render(await RequestHintedOptionalAuth({
      children: <span>Hinted content</span>,
    }));

    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-resolved', 'true');
    expect(getServerAuthStateMock).toHaveBeenCalledTimes(1);
  });

  // A resolved provider never reads the profile again: without the server's
  // figure a recipe surface would not know welcome credits cannot buy it.
  it("starts a hinted provider from the server's spendable balance", async () => {
    const { RequestHintedOptionalAuth } = await import('@/components/RouteAuthBoundary');
    hasAuthHint = true;
    getServerAuthStateMock.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      credits: 1200,
      marketplaceSpendableCredits: 0,
    });

    render(await RequestHintedOptionalAuth({
      children: <span>Hinted content</span>,
    }));

    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-credits', '1200');
    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-spendable-credits', '0');
  });

  it("starts a required provider from the server's spendable balance, and from unknown when there is none", async () => {
    const { RequireAuth } = await import('@/components/RouteAuthBoundary');
    getServerAuthStateMock.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      credits: 1500,
      marketplaceSpendableCredits: 1200,
    });

    const { unmount } = render(await RequireAuth({
      children: <span>Signed-in content</span>,
      returnTo: '/profile',
    }));

    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-resolved', 'true');
    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-spendable-credits', '1200');
    unmount();

    getServerAuthStateMock.mockResolvedValue({ session: { user: { id: 'user-1' } }, credits: 1500 });
    render(await RequireAuth({
      children: <span>Signed-in content</span>,
      returnTo: '/profile',
    }));

    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-spendable-credits', 'null');
  });

  it('keeps the generic optional boundary client-resolved for cacheable routes', async () => {
    const { OptionalAuth } = await import('@/components/RouteAuthBoundary');

    render(
      <OptionalAuth>
        <span>Cacheable content</span>
      </OptionalAuth>
    );

    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-resolved', 'false');
    expect(getServerAuthStateMock).not.toHaveBeenCalled();
  });
});
