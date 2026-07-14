import type { HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileActions } from '@/app/creators/[username]/ProfileActions';
import type { EditableCreatorProfile } from '@/lib/profile';

const mockPush = vi.fn();
const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

let followState = false;
let fetchMock: ReturnType<typeof vi.fn>;

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
    followState = false;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/profile/follow?')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer viewer-token' });
        return {
          ok: true,
          json: async () => ({ following: followState }),
        };
      }

      if (url === '/api/profile/follow') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { following?: boolean };
        followState = Boolean(body.following);
        return {
          ok: true,
          json: async () => ({ following: followState }),
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
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
      expect(fetchMock).toHaveBeenCalledWith('/api/profile/follow', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer viewer-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ followingId: profile.id, following: true }),
      }));
    });
    expect(await screen.findByRole('button', { name: /^following$/i })).toBeInTheDocument();
  });

  it('toggles from following to follow for a logged-in non-owner', async () => {
    followState = true;
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
      expect(fetchMock).toHaveBeenCalledWith('/api/profile/follow', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ followingId: profile.id, following: false }),
      }));
    });
    expect(await screen.findByRole('button', { name: /^follow$/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows loading feedback while follow is pending', async () => {
    let resolveFollow: (value: Response) => void = () => undefined;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/profile/follow?')) {
        return {
          ok: true,
          json: async () => ({ following: false }),
        };
      }

      if (url === '/api/profile/follow') {
        return new Promise((resolve) => {
          resolveFollow = resolve;
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
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

    resolveFollow({
      ok: true,
      json: async () => ({ following: true }),
    } as Response);
    expect(await screen.findByRole('button', { name: /^following$/i })).toBeInTheDocument();
  });

  it('restores the previous follow state when the update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/profile/follow?')) {
        return {
          ok: true,
          json: async () => ({ following: false }),
        };
      }

      return {
        ok: false,
        json: async () => ({ error: 'Insert failed' }),
      };
    });
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
    expect(fetchMock).not.toHaveBeenCalledWith('/api/profile/follow', expect.anything());
  });
});
