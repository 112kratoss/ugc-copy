import type { HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileActions } from '@/app/creators/[username]/ProfileActions';
import type { EditableCreatorProfile } from '@/lib/profile';

const mockPush = vi.fn();
const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

vi.mock('@/app/creations/CreatorProfileCard', () => ({
  default: () => <div data-testid="creator-profile-card" />,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: supabaseMocks.getSession,
    },
    from: supabaseMocks.from,
  },
}));

const profile: EditableCreatorProfile = {
  id: 'creator-1',
  username: 'creator-name',
  displayName: 'Creator Name',
  bio: 'Profile bio',
  avatarUrl: '',
  coverUrl: '',
  websiteUrl: '',
  twitterHandle: '',
  instagramHandle: '',
  tiktokHandle: '',
  location: '',
  credits: 10,
};

describe('ProfileActions', () => {
  beforeEach(() => {
    mockPush.mockReset();
    supabaseMocks.insert.mockReset().mockResolvedValue({ error: null });
    supabaseMocks.delete.mockReset().mockResolvedValue({ error: null });
    supabaseMocks.from.mockImplementation((table: string) => {
      if (table !== 'follows') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              expect(column).toBe('follower_id');
              expect(value).toBe('viewer-1');
              return {
                eq(innerColumn: string, innerValue: unknown) {
                  expect(innerColumn).toBe('following_id');
                  expect(innerValue).toBe(profile.id);
                  return {
                    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                  };
                },
              };
            },
          };
        },
        insert: supabaseMocks.insert,
        delete() {
          return {
            eq(column: string, value: unknown) {
              expect(column).toBe('follower_id');
              expect(value).toBe('viewer-1');
              return {
                eq(innerColumn: string, innerValue: unknown) {
                  expect(innerColumn).toBe('following_id');
                  expect(innerValue).toBe(profile.id);
                  return supabaseMocks.delete();
                },
              };
            },
          };
        },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('toggles follow state for a logged-in non-owner', async () => {
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'viewer-token',
          user: { id: 'viewer-1' },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    const followButton = await screen.findByRole('button', { name: /^follow$/i });
    fireEvent.click(followButton);

    await waitFor(() => {
      expect(supabaseMocks.insert).toHaveBeenCalledWith({
        follower_id: 'viewer-1',
        following_id: profile.id,
      });
    });
    expect(await screen.findByRole('button', { name: /^following$/i })).toBeInTheDocument();
  });

  it('redirects signed-out visitors to login when they click follow', async () => {
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: null,
      },
    });

    render(<ProfileActions profile={profile} />);

    const followButton = await screen.findByRole('button', { name: /^follow$/i });
    fireEvent.click(followButton);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        `/login?returnUrl=${encodeURIComponent('/creators/creator-name')}`
      );
    });
    expect(supabaseMocks.insert).not.toHaveBeenCalled();
  });
});
