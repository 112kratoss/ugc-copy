import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from '@/app/profile/page';

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  website_url: string | null;
  twitter_handle: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  location: string | null;
  credits: number | null;
};

let profileState: ProfileRow | null = null;

const getServerAuthStateMock = vi.fn(async () => ({
  session: {
    user: { id: 'user-1' },
  },
  credits: 10,
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'profiles') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: profileState, error: null };
                },
              };
            },
          };
        },
      };
    },
  }),
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
    <div data-testid="direct-creator-profile-card">
      {isLoading ? 'loading' : loadError ?? initialProfile?.username ?? 'empty'}
    </div>
  ),
}));

vi.mock('@/app/profile/DeferredCreatorProfileCard', () => ({
  default: ({
    initialProfile,
    isLoading,
    loadError,
  }: {
    initialProfile: { username?: string | null } | null;
    isLoading: boolean;
    loadError: string | null;
  }) => (
    <div data-testid="deferred-creator-profile-card">
      {isLoading ? 'loading' : loadError ?? initialProfile?.username ?? 'empty'}
    </div>
  ),
}));

describe('ProfilePage', () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    getServerAuthStateMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps persisted profiles editable and links to the public profile', async () => {
    profileState = {
      id: 'user-1',
      username: 'persisted-name',
      display_name: 'Creator Name',
      bio: null,
      avatar_url: null,
      cover_url: null,
      website_url: null,
      twitter_handle: null,
      instagram_handle: null,
      tiktok_handle: null,
      location: null,
      credits: 10,
    };

    render(await ProfilePage({}));

    expect(screen.getByTestId('deferred-creator-profile-card')).toHaveTextContent('persisted-name');
    expect(screen.queryByTestId('direct-creator-profile-card')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view public profile/i })).toHaveAttribute(
      'href',
      '/creators/persisted-name'
    );
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('keeps first-time users on /profile and prefills the suggested username', async () => {
    profileState = {
      id: 'user-1',
      username: null,
      display_name: 'Creator Name',
      bio: null,
      avatar_url: null,
      cover_url: null,
      website_url: null,
      twitter_handle: null,
      instagram_handle: null,
      tiktok_handle: null,
      location: null,
      credits: 10,
    };

    render(await ProfilePage({}));

    expect(await screen.findByText('creator-user1')).toBeInTheDocument();
    expect(screen.getByText(/profile setup/i)).toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('renders a starter profile if the profile row is missing', async () => {
    profileState = null;

    render(await ProfilePage({}));

    expect(await screen.findByText('creator-user1')).toBeInTheDocument();
    expect(screen.queryByText(/profile not found/i)).not.toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
