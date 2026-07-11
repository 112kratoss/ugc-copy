import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreatorProfileCard from '@/app/creations/CreatorProfileCard';
import type { EditableCreatorProfile } from '@/lib/profile';

const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateUser: vi.fn(),
  from: vi.fn(),
  upload: vi.fn(),
  uploadToSignedUrl: vi.fn(),
  remove: vi.fn(),
  getPublicUrl: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMocks,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: supabaseMocks.getSession,
      updateUser: supabaseMocks.updateUser,
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
  websiteUrl: 'https://creator.example.com',
  twitterHandle: '',
  instagramHandle: '',
  tiktokHandle: '',
  location: 'Kochi, India',
  credits: 100,
};

describe('CreatorProfileCard', () => {
  beforeEach(() => {
    routerMocks.replace.mockReset();
    routerMocks.refresh.mockReset();
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'test-token',
          user: { id: 'test-user-id' },
        },
      },
    });
    supabaseMocks.updateUser.mockResolvedValue({ error: null });
    supabaseMocks.upload.mockResolvedValue({ error: null });
    supabaseMocks.uploadToSignedUrl.mockResolvedValue({ error: null });
    supabaseMocks.remove.mockResolvedValue({ error: null });
    supabaseMocks.getPublicUrl.mockImplementation((path: string) => ({
      data: { publicUrl: `https://cdn.example.com/${path}` },
    }));
    supabaseMocks.from.mockReturnValue({
      upload: supabaseMocks.upload,
      uploadToSignedUrl: supabaseMocks.uploadToSignedUrl,
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
            websiteUrl: 'https://creator.example.com',
            twitterHandle: '',
            instagramHandle: '',
            tiktokHandle: '',
            location: 'Kochi, India',
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
    const validationBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const patchBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(validationBody).toMatchObject({
      location: 'Kochi, India',
      websiteUrl: 'https://creator.example.com',
    });
    expect(patchBody).toMatchObject({
      location: 'Kochi, India',
      websiteUrl: 'https://creator.example.com',
    });
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

    expect(screen.getByText(/profile essentials/i)).toBeInTheDocument();
    expect(screen.getByText(/public preview/i)).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 essentials complete/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save and continue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /skip for now/i })).toBeInTheDocument();
  });

  it('lets creators preserve their public website, location, and social handles', () => {
    render(
      <CreatorProfileCard
        initialProfile={profile}
        isLoading={false}
        loadError={null}
      />
    );

    expect(screen.getByText(/^Location$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Website$/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'More about you' })).toBeInTheDocument();
    expect(screen.getByText(/^X \(Twitter\) Handle$/i)).toBeInTheDocument();
  });

  it('keeps optional details collapsed during first-run setup', () => {
    render(
      <CreatorProfileCard
        initialProfile={{
          ...profile,
          username: 'creator-a1b2c3d4',
          displayName: '',
          avatarUrl: '',
        }}
        isLoading={false}
        loadError={null}
        onboardingMode
      />
    );

    expect(screen.getByText(/add optional details/i).closest('details')).not.toHaveAttribute('open');
    expect(screen.getByLabelText(/username required/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/display name required/i)).toBeInTheDocument();
  });

  it('focuses the generated handle and explains how to finish essentials', async () => {
    render(
      <CreatorProfileCard
        initialProfile={{
          ...profile,
          username: 'creator-a1b2c3d4',
          displayName: '',
          avatarUrl: '',
        }}
        isLoading={false}
        loadError={null}
        onboardingMode
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /save and continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/username required/i)).toHaveFocus();
    });
    expect(screen.getByText(/replace the generated handle/i)).toBeInTheDocument();
    expect(screen.getByText(/complete the highlighted essentials/i)).toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('returns to the preserved creation after onboarding save', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/profile/validate')) {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url.endsWith('/api/profile')) {
        return {
          ok: true,
          json: async () => ({
            ...profile,
            username: 'my-studio',
            displayName: 'My Studio',
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    render(
      <CreatorProfileCard
        initialProfile={{ ...profile, username: 'my-studio', displayName: 'My Studio' }}
        isLoading={false}
        loadError={null}
        onboardingMode
        nextPath="/create-video?model=kling"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /save and continue/i }));

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/create-video?model=kling');
    });
    expect(routerMocks.refresh).toHaveBeenCalled();
  });

  it('returns a ready creator to the interrupted task after a repair save', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/profile/validate')) {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url.endsWith('/api/profile')) {
        return { ok: true, json: async () => profile } as Response;
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    render(
      <CreatorProfileCard
        initialProfile={profile}
        isLoading={false}
        loadError={null}
        nextPath="/post/new?generationId=gen-1"
        returnAfterSave
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /save and return/i }));

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/post/new?generationId=gen-1');
    });
    expect(routerMocks.refresh).toHaveBeenCalled();
  });

  it('allows onboarding to be skipped without losing the intended destination', async () => {
    render(
      <CreatorProfileCard
        initialProfile={{ ...profile, username: 'creator-a1b2c3d4', displayName: '' }}
        isLoading={false}
        loadError={null}
        onboardingMode
        nextPath="/create-image?model=gpt-image-2"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/create-image?model=gpt-image-2');
    });
    expect(supabaseMocks.updateUser).toHaveBeenCalledWith({
      data: { creator_profile_onboarding_skipped_version: 1 },
    });
    expect(routerMocks.refresh).toHaveBeenCalled();
  });

  it('uses the avatar image itself for drag and scroll cropping', () => {
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

    const cropControl = screen.getByRole('button', {
      name: /drag avatar image to position the face\. scroll to zoom\./i,
    });
    const cropPreview = screen.getByAltText('Cropped avatar preview');

    expect(screen.getByRole('slider', { name: /avatar zoom/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom in avatar/i })).toBeInTheDocument();
    expect(screen.queryByText(/^Fine tune X$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Fine tune Y$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /smart portrait/i })).not.toBeInTheDocument();
    expect(cropPreview).toHaveStyle('transform: scale(1.35)');

    fireEvent.wheel(cropControl, { deltaY: -120 });

    expect(cropPreview).toHaveStyle('transform: scale(1.43)');

    fireEvent.click(screen.getByRole('button', { name: /zoom out avatar/i }));
    expect(cropPreview).toHaveStyle('transform: scale(1.35)');
  });

  it('uses the cover banner itself for drag and scroll cropping', () => {
    render(
      <CreatorProfileCard
        initialProfile={profile}
        isLoading={false}
        loadError={null}
      />
    );

    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const file = new File(['cover'], 'cover.png', { type: 'image/png' });

    fireEvent.change(fileInputs[1], {
      target: { files: [file] },
    });

    const cropControl = screen.getByRole('button', {
      name: /drag cover image to position it\. scroll to zoom\./i,
    });
    const cropPreview = screen.getByAltText('Cover preview');

    expect(screen.queryByText(/^Fine tune X$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Fine tune Y$/i)).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /cover zoom/i })).toBeInTheDocument();
    expect(cropPreview).toHaveStyle('transform: scale(1)');

    fireEvent.wheel(cropControl, { deltaY: -120 });

    expect(cropPreview).toHaveStyle('transform: scale(1.08)');
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

      if (url.endsWith('/api/profile/media/sign')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            bucket: 'profiles',
            path: 'test-user-id/avatar-server-issued.png',
            token: 'profile-upload-token',
            signedUploadUrl: 'https://storage.example.test/profile-upload-token',
            publicUrl: 'https://cdn.example.com/test-user-id/avatar-server-issued.png',
            expiresInSeconds: 7200,
          }),
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

      if (url.endsWith('/api/profile/media/cleanup')) {
        return {
          ok: true,
          json: async () => ({ success: true }),
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

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/profile/media/sign',
      expect.objectContaining({
        method: 'POST',
      })
    );
    expect(supabaseMocks.uploadToSignedUrl).toHaveBeenCalledWith(
      'test-user-id/avatar-server-issued.png',
      'profile-upload-token',
      file,
      { contentType: 'image/png' }
    );
    expect(supabaseMocks.upload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/profile/media/cleanup',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ paths: ['test-user-id/avatar-server-issued.png'] }),
      })
    );
    expect(supabaseMocks.remove).not.toHaveBeenCalled();
  });
});
