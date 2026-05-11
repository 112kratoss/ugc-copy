import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreatorProfileCard from '@/app/creations/CreatorProfileCard';
import type { EditableCreatorProfile } from '@/lib/profile';

const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  from: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  getPublicUrl: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: supabaseMocks.getSession,
    },
    storage: {
      from: supabaseMocks.from,
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
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'test-token',
          user: { id: 'test-user-id' },
        },
      },
    });
    supabaseMocks.upload.mockResolvedValue({ error: null });
    supabaseMocks.remove.mockResolvedValue({ error: null });
    supabaseMocks.getPublicUrl.mockImplementation((path: string) => ({
      data: { publicUrl: `https://cdn.example.com/${path}` },
    }));
    supabaseMocks.from.mockReturnValue({
      upload: supabaseMocks.upload,
      remove: supabaseMocks.remove,
      getPublicUrl: supabaseMocks.getPublicUrl,
    });

    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('validates before patching and updates the preview link after a successful save', async () => {
    const onProfileSaved = vi.fn();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url.endsWith('/api/profile/validate')) {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        } as Response;
      }

      if (url.endsWith('/api/profile')) {
        return {
          ok: true,
          json: async () => ({
            id: 'user-1',
            username: 'updated-name',
            displayName: 'Updated Name',
            bio: 'Updated bio',
            avatarUrl: 'https://example.com/updated.jpg',
            coverUrl: '',
            websiteUrl: '',
            twitterHandle: '',
            instagramHandle: '',
            tiktokHandle: '',
            location: '',
            credits: 25,
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });

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

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/profile/validate',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/profile',
      expect.objectContaining({ method: 'PATCH' })
    );
    expect(onProfileSaved).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /preview profile/i })).toHaveAttribute('href', '/creators/updated-name');
  });

  it('shows first-run setup progress when used for onboarding', () => {
    render(
      <CreatorProfileCard
        initialProfile={{
          ...profile,
          username: 'starter-name',
          displayName: '',
          bio: '',
          avatarUrl: '',
        }}
        isLoading={false}
        loadError={null}
        onboardingMode
      />
    );

    expect(screen.getByText(/setup progress/i)).toBeInTheDocument();
    expect(screen.getByText(/public preview/i)).toBeInTheDocument();
    expect(screen.getByText(/save the handle first/i)).toBeInTheDocument();
  });

  it('rejects non-image profile uploads before save', () => {
    render(
      <CreatorProfileCard
        initialProfile={profile}
        isLoading={false}
        loadError={null}
      />
    );

    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const file = new File(['not-an-image'], 'avatar.pdf', { type: 'application/pdf' });

    fireEvent.change(fileInputs[0], {
      target: { files: [file] },
    });

    expect(screen.getByText(/upload an image file/i)).toBeInTheDocument();
    expect(supabaseMocks.upload).not.toHaveBeenCalled();
  });

  it('shows validation errors from the validate endpoint without uploading files', async () => {
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

    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' });

    fireEvent.change(fileInputs[0], {
      target: { files: [file] },
    });
    fireEvent.change(screen.getByPlaceholderText('creator-name'), {
      target: { value: 'Bad Name!' },
    });

    fireEvent.submit(screen.getByRole('button', { name: /save changes/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/use 3-24 lowercase letters/i)).toBeInTheDocument();
    });

    expect(supabaseMocks.upload).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('removes newly uploaded media if the profile patch fails after upload', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1712345678901);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url.endsWith('/api/profile/validate')) {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        } as Response;
      }

      if (url.endsWith('/api/profile')) {
        return {
          ok: false,
          json: async () => ({
            error: 'That username is already taken.',
            fieldErrors: {
              username: 'That username is already taken.',
            },
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });

    render(
      <CreatorProfileCard
        initialProfile={profile}
        isLoading={false}
        loadError={null}
      />
    );

    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' });

    fireEvent.change(fileInputs[0], {
      target: { files: [file] },
    });

    fireEvent.submit(screen.getByRole('button', { name: /save changes/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getAllByText(/already taken/i).length).toBeGreaterThan(0);
    });

    expect(supabaseMocks.upload).toHaveBeenCalledWith(
      'test-user-id/avatar-1712345678901.png',
      file,
      { upsert: true }
    );
    expect(supabaseMocks.remove).toHaveBeenCalledWith([
      'test-user-id/avatar-1712345678901.png',
    ]);
  });
});
