import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AppShellAccount from '@/app/components/AppShellAccount';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
      signOut: vi.fn(),
    },
    from: () => ({ select: mocks.select }),
  },
}));

describe('AppShellAccount', () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.onAuthStateChange.mockReset();
    mocks.select.mockReset();
    mocks.eq.mockReset();
    mocks.maybeSingle.mockReset();

    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          user: {
            id: 'user-1',
            email: 'creator@example.com',
            user_metadata: {},
          },
        },
      },
    });
    mocks.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    mocks.select.mockReturnValue({ eq: mocks.eq });
    mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.maybeSingle.mockResolvedValue({
      data: {
        display_name: 'Test Creator',
        avatar_url: null,
        credits: 1295,
      },
    });
  });

  it('loads the real profile fields and displays the stored credit balance', async () => {
    render(<AppShellAccount />);

    expect(await screen.findByText('1295 credits')).toBeInTheDocument();
    expect(mocks.select).toHaveBeenCalledWith('display_name, avatar_url, credits');
    await waitFor(() => expect(mocks.eq).toHaveBeenCalledWith('id', 'user-1'));
  });
});
