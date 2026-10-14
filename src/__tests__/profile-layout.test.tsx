import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfileLayout from '@/app/profile/layout';

const navigation = vi.hoisted(() => ({
  router: { replace: vi.fn() },
  pathname: '/profile/blocked',
  searchParams: new URLSearchParams(),
}));

const serverAuth = vi.hoisted(() => ({
  state: { session: null, credits: null } as { session: { user: { id: string } } | null; credits: number | null },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation.router,
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: async () => serverAuth.state,
}));

vi.mock('@/components/RouteAuthBoundary', () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="signed-in-boundary">{children}</div>
  ),
}));

describe('ProfileLayout', () => {
  beforeEach(() => {
    navigation.router.replace.mockReset();
    navigation.pathname = '/profile/blocked';
    navigation.searchParams = new URLSearchParams();
    serverAuth.state = { session: null, credits: null };
  });

  // Every /profile page sent a signed-out visitor to `/login?returnUrl=/profile`,
  // so signing in from the blocked list or the editor landed somewhere else.
  it.each([
    ['/profile/blocked', '', '/login?returnUrl=%2Fprofile%2Fblocked'],
    ['/profile/edit', '', '/login?returnUrl=%2Fprofile%2Fedit'],
    ['/profile', 'tab=saved&post=post-1', '/login?returnUrl=%2Fprofile%3Ftab%3Dsaved%26post%3Dpost-1'],
  ])('sends a signed-out visitor on %s to sign in and back to it', async (pathname, query, target) => {
    navigation.pathname = pathname;
    navigation.searchParams = new URLSearchParams(query);

    render(<StrictMode>{await ProfileLayout({ children: <p>Private page</p> })}</StrictMode>);

    expect(navigation.router.replace).toHaveBeenCalledWith(target);
    expect(new Set(navigation.router.replace.mock.calls.map(([url]) => url))).toEqual(new Set([target]));
    expect(screen.getByRole('status')).toHaveTextContent('Taking you to sign in…');
    expect(screen.queryByText('Private page')).not.toBeInTheDocument();
  });

  it('draws the page for a signed-in visitor, and sends nobody anywhere', async () => {
    serverAuth.state = { session: { user: { id: 'owner-1' } }, credits: 5 };

    render(await ProfileLayout({ children: <p>Private page</p> }));

    expect(screen.getByTestId('signed-in-boundary')).toHaveTextContent('Private page');
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });
});
