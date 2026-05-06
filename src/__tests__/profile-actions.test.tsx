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

let followLookupData: { follower_id: string } | null = null;
let followLookupError: unknown = null;

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
    followLookupData = null;
    followLookupError = null;
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
                    maybeSingle: vi.fn(async () => ({
                      data: followLookupData,
                      error: followLookupError,
                    })),
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
    vi.unstubAllGlobals();
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

  it('toggles from following to follow for a logged-in non-owner', async () => {
    followLookupData = { follower_id: 'viewer-1' };
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'viewer-token',
          user: { id: 'viewer-1' },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    const followingButton = await screen.findByRole('button', { name: /^following$/i });
    expect(followingButton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(followingButton);

    await waitFor(() => {
      expect(supabaseMocks.delete).toHaveBeenCalled();
    });
    expect(await screen.findByRole('button', { name: /^follow$/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows loading feedback while follow is pending', async () => {
    let resolveInsert: (value: { error: null }) => void = () => undefined;
    supabaseMocks.insert.mockImplementation(
      () => new Promise((resolve) => {
        resolveInsert = resolve;
      })
    );
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'viewer-token',
          user: { id: 'viewer-1' },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    fireEvent.click(await screen.findByRole('button', { name: /^follow$/i }));

    const loadingButton = await screen.findByRole('button', { name: /following\.\.\./i });
    expect(loadingButton).toBeDisabled();
    expect(screen.getAllByText('Following creator...').length).toBeGreaterThan(0);

    resolveInsert({ error: null });
    expect(await screen.findByRole('button', { name: /^following$/i })).toBeInTheDocument();
  });

  it('restores the previous follow state when the update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    supabaseMocks.insert.mockResolvedValue({ error: new Error('Insert failed') });
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'viewer-token',
          user: { id: 'viewer-1' },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    fireEvent.click(await screen.findByRole('button', { name: /^follow$/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/previous state was restored/i).length).toBeGreaterThan(0);
    });
    expect(await screen.findByRole('button', { name: /^follow$/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps owners on edit profile instead of follow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: profile.id,
        username: profile.username,
        suggestedUsername: profile.username,
        displayName: profile.displayName,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        coverUrl: profile.coverUrl,
        websiteUrl: profile.websiteUrl,
        twitterHandle: profile.twitterHandle,
        instagramHandle: profile.instagramHandle,
        tiktokHandle: profile.tiktokHandle,
        location: profile.location,
        credits: profile.credits,
      }),
    })));
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'owner-token',
          user: { id: profile.id },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    expect(await screen.findByRole('button', { name: /edit profile/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^follow$/i })).not.toBeInTheDocument();
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
