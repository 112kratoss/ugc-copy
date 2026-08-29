import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NavbarClient from '@/app/components/NavbarClient';

const getSessionMock = vi.fn();
const onAuthStateChangeMock = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: (...args: unknown[]) => onAuthStateChangeMock(...args),
      signOut: vi.fn(),
    },
    from: vi.fn(),
  },
}));

describe('NavbarClient', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    onAuthStateChangeMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    onAuthStateChangeMock.mockReturnValue({
      data: {
        subscription: {
          unsubscribe: vi.fn(),
        },
      },
    });
  });

  it('keeps public navigation labels stable between server markup and client render', () => {
    const serverMarkup = renderToString(<NavbarClient />);

    expect(serverMarkup).toContain('Community');
    expect(serverMarkup).toContain('Search');
    expect(serverMarkup).not.toContain('Feed');

    render(<NavbarClient />);

    expect(screen.getAllByRole('link', { name: 'Community' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Search' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Feed' })).not.toBeInTheDocument();
  });
});
