import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from '@/app/profile/page';

const mockPush = vi.fn();
const mockReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: { access_token: 'test-token' },
        },
      })),
    },
  },
}));

vi.mock('@/app/creations/CreatorProfileCard', () => ({
  default: ({
    initialProfile,
    isLoading,
    loadError,
  }: {
    initialProfile: { username?: string | null } | null;
    isLoading: boolean;
    loadError: string | null;
  }) => (
    <div data-testid="creator-profile-card">
      {isLoading ? 'loading' : loadError ?? initialProfile?.username ?? 'empty'}
    </div>
  ),
}));

describe('ProfilePage', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockReplace.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redirects to the public profile when a persisted username exists', async () => {
    vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'user-1',
          username: 'persisted-name',
          suggestedUsername: 'creator-user1',
          displayName: 'Creator Name',
          bio: null,
          avatarUrl: null,
          coverUrl: null,
          websiteUrl: null,
          twitterHandle: null,
          instagramHandle: null,
          tiktokHandle: null,
          location: null,
          credits: 10,
        }),
      } as Response);

    render(<ProfilePage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/creators/persisted-name');
    });
  });

  it('keeps first-time users on /profile and prefills the suggested username', async () => {
    vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'user-1',
          username: null,
          suggestedUsername: 'creator-user1',
          displayName: 'Creator Name',
          bio: null,
          avatarUrl: null,
          coverUrl: null,
          websiteUrl: null,
          twitterHandle: null,
          instagramHandle: null,
          tiktokHandle: null,
          location: null,
          credits: 10,
        }),
      } as Response);

    render(<ProfilePage />);

    expect(await screen.findByText('creator-user1')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
