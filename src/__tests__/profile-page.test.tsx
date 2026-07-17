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
    user: {
      id: 'a1b2c3d4-1111-2222-3333-444455556666',
      user_metadata: {
        name: 'OAuth Creator',
        avatar_url: 'https://cdn.example.com/oauth-avatar.jpg',
      },
    },
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
    initialProfile: { username?: string | null; displayName?: string; avatarUrl?: string } | null;
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
    onboardingMode,
    nextPath,
    returnAfterSave,
  }: {
    initialProfile: { username?: string | null; displayName?: string; avatarUrl?: string } | null;
    isLoading: boolean;
    loadError: string | null;
    onboardingMode?: boolean;
    nextPath?: string;
    returnAfterSave?: boolean;
  }) => (
    <div
      data-testid="deferred-creator-profile-card"
      data-onboarding={onboardingMode ? 'true' : 'false'}
      data-next-path={nextPath}
      data-display-name={initialProfile?.displayName}
      data-avatar-url={initialProfile?.avatarUrl}
      data-return-after-save={returnAfterSave ? 'true' : 'false'}
    >
      {isLoading ? 'loading' : loadError ?? initialProfile?.username ?? 'empty'}
    </div>
  ),
}));

vi.mock('@/app/profile/OwnerProfileMediaHub', () => ({
  default: ({ creator }: { creator: { name: string; username: string | null } }) => (
    <div data-testid="owner-profile-media-hub" data-creator-name={creator.name} data-username={creator.username ?? ''}>
      Profile media hub
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
      id: 'a1b2c3d4-1111-2222-3333-444455556666',
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
    expect(screen.getByTestId('deferred-creator-profile-card')).toHaveAttribute('data-onboarding', 'false');
    expect(screen.getByTestId('owner-profile-media-hub')).toHaveAttribute('data-username', 'persisted-name');
    expect(screen.getByRole('link', { name: /edit profile/i })).toHaveAttribute('href', '#profile-settings');
  });

  it('keeps first-time users on /profile and prefills the suggested username', async () => {
    profileState = {
      id: 'a1b2c3d4-1111-2222-3333-444455556666',
      username: null,
      display_name: null,
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

    expect(await screen.findByText('creator-a1b2c3d4')).toBeInTheDocument();
    expect(screen.getByText(/profile setup/i)).toBeInTheDocument();
    expect(screen.getByTestId('deferred-creator-profile-card')).toHaveAttribute('data-onboarding', 'true');
    expect(screen.getByTestId('deferred-creator-profile-card')).toHaveAttribute('data-display-name', 'OAuth Creator');
    expect(screen.getByTestId('deferred-creator-profile-card')).toHaveAttribute('data-avatar-url', 'https://cdn.example.com/oauth-avatar.jpg');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('renders a starter profile if the profile row is missing', async () => {
    profileState = null;

    render(await ProfilePage({}));

    expect(await screen.findByText('creator-a1b2c3d4')).toBeInTheDocument();
    expect(screen.queryByText(/profile not found/i)).not.toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('preserves a safe creation destination through setup', async () => {
    profileState = {
      id: 'a1b2c3d4-1111-2222-3333-444455556666',
      username: 'creator-a1b2c3d4',
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

    render(await ProfilePage({
      searchParams: Promise.resolve({ next: '/create-image?model=gpt-image-2' }),
    }));

    expect(screen.getByTestId('deferred-creator-profile-card')).toHaveAttribute(
      'data-next-path',
      '/create-image?model=gpt-image-2'
    );
    expect(screen.getByTestId('deferred-creator-profile-card')).toHaveAttribute(
      'data-return-after-save',
      'true'
    );
    expect(screen.queryByRole('link', { name: /view public profile/i })).not.toBeInTheDocument();
  });

  it('does not restart onboarding for a ready profile just because welcome remains in the URL', async () => {
    profileState = {
      id: 'a1b2c3d4-1111-2222-3333-444455556666',
      username: 'creator-name',
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

    render(await ProfilePage({ searchParams: Promise.resolve({ welcome: '1' }) }));

    expect(screen.getByTestId('deferred-creator-profile-card')).toHaveAttribute('data-onboarding', 'false');
    expect(screen.queryByText(/profile setup/i)).not.toBeInTheDocument();
  });
});
