import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreatorProfileCard from '@/app/creations/CreatorProfileCard';
import type { EditableCreatorProfile } from '@/lib/profile';

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

const profile: EditableCreatorProfile = {
  id: 'test-user-id',
  username: 'test-creator',
  displayName: 'Test Creator',
  bio: 'This is a test bio',
  avatarUrl: 'https://example.com/avatar.jpg',
  coverUrl: '',
  websiteUrl: '',
  twitterHandle: '',
  instagramHandle: '',
  tiktokHandle: '',
  location: '',
  credits: 100,
};

describe('CreatorProfileCard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('saves creator profile edits and updates the preview link', async () => {
    const onProfileSaved = vi.fn();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'user-1',
        username: 'updated-name',
        displayName: 'Updated Name',
        bio: 'Updated bio',
        avatarUrl: 'https://example.com/updated.jpg',
        credits: 25,
      }),
    } as Response);

    render(
      <CreatorProfileCard
        initialProfile={profile}
        isLoading={false}
        loadError={null}
        onProfileSaved={onProfileSaved}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('creator-name'), {
      target: { value: 'Updated-Name' },
    });

    fireEvent.submit(screen.getByRole('button', { name: /save changes/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Creator profile updated.')).toBeInTheDocument();
    });

    expect(onProfileSaved).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /preview profile/i })).toHaveAttribute('href', '/creators/updated-name');
  });

  it('shows validation errors returned by the profile API', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: 'Please fix the highlighted fields.',
        fieldErrors: {
          username: 'Use 3-24 lowercase letters, numbers, or hyphens.',
        },
      }),
    } as Response);

    render(
      <CreatorProfileCard
        initialProfile={profile}
        isLoading={false}
        loadError={null}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('creator-name'), {
      target: { value: 'Bad Name!' },
    });

    fireEvent.submit(screen.getByRole('button', { name: /save changes/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/use 3-24 lowercase letters/i)).toBeInTheDocument();
    });
  });
});
