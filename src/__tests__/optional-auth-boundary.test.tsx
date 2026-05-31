import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerAuthStateMock = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
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
  });

  it('does not read server auth before rendering cacheable public routes', async () => {
    const { OptionalAuth } = await import('@/app/components/RouteAuthBoundary');

    render(
      <OptionalAuth>
        <span>Public content</span>
      </OptionalAuth>
    );

    expect(screen.getByText('Public content')).toBeInTheDocument();
    expect(screen.getByTestId('auth-provider')).toHaveAttribute('data-resolved', 'false');
    expect(getServerAuthStateMock).not.toHaveBeenCalled();
  });
});
