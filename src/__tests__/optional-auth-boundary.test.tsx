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

vi.mock('@/app/components/AuthProvider', () => ({
  AuthProvider: ({
    children,
    hasResolvedInitialState = false,
  }: {
    children: ReactNode;
    hasResolvedInitialState?: boolean;
  }) => (
    <div data-testid="auth-provider" data-resolved={String(hasResolvedInitialState)}>
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
    const { RequestHintedOptionalAuth } = await import('@/app/components/RouteAuthBoundary');

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
    const { RequestHintedOptionalAuth } = await import('@/app/components/RouteAuthBoundary');
    hasAuthHint = true;
    getServerAuthStateMock.mockResolvedValue({ session: null, credits: null });

    render(await RequestHintedOptionalAuth({
      children: <span>Hinted content</span>,
    }));

    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-resolved', 'true');
    expect(getServerAuthStateMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the generic optional boundary client-resolved for cacheable routes', async () => {
    const { OptionalAuth } = await import('@/app/components/RouteAuthBoundary');

    render(
      <OptionalAuth>
        <span>Cacheable content</span>
      </OptionalAuth>
    );

    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-resolved', 'false');
    expect(getServerAuthStateMock).not.toHaveBeenCalled();
  });
});
