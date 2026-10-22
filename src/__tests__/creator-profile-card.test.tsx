import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreatorProfileCard from '@/app/creations/CreatorProfileCard';
import FeedbackViewport from '@/components/FeedbackViewport';
import { resetFeedbackState } from '@/components/feedback-state';
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
  push: vi.fn(),
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
    routerMocks.push.mockReset();
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
    resetFeedbackState();
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

  it('blocks an ordinary save when the display name is blank, but not for a blank bio', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CreatorProfileCard
        initialProfile={{ ...profile, displayName: '', bio: '' }}
        loadError={null}
      />
    );

    const form = screen.getByRole('button', { name: /save changes/i }).closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/add the name you want people to see/i)).toBeInTheDocument();
    });
    // The field is labelled Required outside onboarding too, so nothing may
    // reach the API until it is filled in.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('Your creator name'), {
      target: { value: 'Named Creator' },
    });
    fireEvent.submit(form);

    // An empty bio is still perfectly saveable.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe('the leave guard on Back', () => {
    // The browser's Back: the entry on top comes off and popstate follows.
    const pressBack = () => act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    });
    // `history.back()` from the page itself, answered as a browser would: later.
    const answerBackLater = () => vi.spyOn(window.history, 'back').mockImplementation(() => {
      window.setTimeout(() => window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state })), 0);
    });
    const typeName = (value: string) => fireEvent.change(screen.getByPlaceholderText('Your creator name'), {
      target: { value },
    });
    // A plain link elsewhere on the page, as the shell's are.
    const pageLinks: HTMLAnchorElement[] = [];
    const addPageLink = (href: string) => {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = 'Explore';
      document.body.append(link);
      pageLinks.push(link);
      return link;
    };
    afterEach(() => {
      pageLinks.splice(0).forEach((link) => link.remove());
    });

    // Back and a phone's back swipe left /profile/edit without a word: the
    // guard saw link clicks and tab closes only.
    it('asks before Back leaves typed changes, and keeps them when the person stays', async () => {
      const pushState = vi.spyOn(window.history, 'pushState');
      const back = answerBackLater();
      render(
        <>
          <CreatorProfileCard initialProfile={profile} loadError={null} />
          <FeedbackViewport />
        </>
      );
      expect(pushState).not.toHaveBeenCalled();

      typeName('New Name');

      // One entry for the same address goes on top while the form is dirty.
      expect(pushState).toHaveBeenCalledTimes(1);
      expect(pushState.mock.calls[0][2]).toBe(window.location.href);

      pressBack();

      // The entry goes back on top while the question is up, so a second Back
      // cannot slip past it.
      const question = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
      expect(question).toHaveAccessibleDescription('Your profile changes haven’t been saved and will be lost.');
      expect(pushState).toHaveBeenCalledTimes(2);
      expect(pushState.mock.calls[1][2]).toBe(window.location.href);

      // Staying: nothing moves and nothing typed is lost.
      fireEvent.click(within(question).getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(back).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText('Your creator name')).toHaveValue('New Name');

      pressBack();
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave without saving' }));

      // Leaving: off the guard entry, then the Back that was asked for.
      await waitFor(() => expect(back).toHaveBeenCalledTimes(2));
      expect(pushState).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('asks again, rather than leaving, for a Back pressed while the question is up', async () => {
      const pushState = vi.spyOn(window.history, 'pushState');
      const back = answerBackLater();
      render(
        <>
          <CreatorProfileCard initialProfile={profile} loadError={null} />
          <FeedbackViewport />
        </>
      );
      typeName('New Name');

      pressBack();
      await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
      pressBack();

      // The second Back took the guard entry off and it went straight back on:
      // still one question, and the page is still here.
      expect(pushState).toHaveBeenCalledTimes(3);
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(back).not.toHaveBeenCalled();
      expect(pushState).toHaveBeenCalledTimes(3);
      expect(screen.getByPlaceholderText('Your creator name')).toHaveValue('New Name');
    });

    it('takes its question down when the page goes while it is up', async () => {
      render(<FeedbackViewport />);
      const page = render(<CreatorProfileCard initialProfile={profile} loadError={null} />);
      typeName('New Name');
      fireEvent.click(addPageLink('/showcase'));
      await screen.findByRole('alertdialog', { name: 'Leave without saving?' });

      // A jump several entries back, say: the page is gone, and so is its question.
      page.unmount();

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(routerMocks.push).not.toHaveBeenCalled();
    });

    it('lets Back through without a question once the changes are reset', () => {
      const confirm = vi.spyOn(window, 'confirm');
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      render(<CreatorProfileCard initialProfile={profile} loadError={null} />);
      typeName('New Name');
      fireEvent.click(screen.getByRole('button', { name: /reset changes/i }));

      pressBack();

      expect(confirm).not.toHaveBeenCalled();
      expect(back).toHaveBeenCalledTimes(1);
    });

    it('steps off its entry before a save moves on, so no stop is left behind', async () => {
      const back = answerBackLater();
      vi.mocked(fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('/api/profile/validate')) return { ok: true, json: async () => ({ ok: true }) } as Response;
        if (url.endsWith('/api/profile')) {
          return { ok: true, json: async () => ({ ...profile, displayName: 'New Name' }) } as Response;
        }
        throw new Error(`Unexpected fetch to ${url}`);
      });
      render(<CreatorProfileCard initialProfile={profile} loadError={null} />);
      typeName('New Name');

      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith('/profile'));
      expect(back).toHaveBeenCalledTimes(1);
      expect(back.mock.invocationCallOrder[0]).toBeLessThan(routerMocks.replace.mock.invocationCallOrder[0]);
      expect(routerMocks.refresh).toHaveBeenCalled();
    });

    it('steps off its entry before following a link the person chose to leave by', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const back = answerBackLater();
      render(<CreatorProfileCard initialProfile={profile} loadError={null} />);
      const link = addPageLink('/showcase?tab=new');
      typeName('New Name');

      const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      fireEvent(link, click);

      expect(click.defaultPrevented).toBe(true);
      await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/showcase?tab=new'));
      expect(back.mock.invocationCallOrder[0]).toBeLessThan(routerMocks.push.mock.invocationCallOrder[0]);
    });

    it('asks nothing for a click that opens a new tab', () => {
      const confirm = vi.spyOn(window, 'confirm');
      render(<CreatorProfileCard initialProfile={profile} loadError={null} />);
      const link = addPageLink('/showcase');
      typeName('New Name');
      // The browser would open a new tab; jsdom would navigate this one instead.
      link.addEventListener('click', (event) => event.preventDefault());

      fireEvent.click(link, { metaKey: true });

      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it('marks the display name as a required field', () => {
    render(
      <CreatorProfileCard
        initialProfile={profile}
        loadError={null}
      />
    );

    expect(screen.getByPlaceholderText('Your creator name')).toBeRequired();
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
        loadError={null}
      />
    );

    expect(screen.getByText(/^Location$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Website$/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'More about you' })).toBeInTheDocument();
    expect(screen.getByText(/^X \(Twitter\) Handle$/i)).toBeInTheDocument();
  });

  // A photo is never required to publish or sell (marketplace-trust.ts); two
  // lines said it was required before selling recipes.
  it('recommends a photo for buyer trust without calling it a requirement', () => {
    const { unmount } = render(
      <CreatorProfileCard initialProfile={{ ...profile, avatarUrl: '' }} loadError={null} />
    );

    expect(screen.getByText('Recommended — builds buyer trust. JPG, PNG, or WebP up to 5MB.')).toBeInTheDocument();
    expect(screen.queryByText(/required before selling/i)).not.toBeInTheDocument();
    unmount();

    render(
      <CreatorProfileCard
        initialProfile={{ ...profile, avatarUrl: '' }}
        loadError={null}
        onboardingMode
      />
    );

    expect(screen.getByText('Avatar recommended — builds buyer trust.')).toBeInTheDocument();
    expect(screen.queryByText(/before selling/i)).not.toBeInTheDocument();
  });

  // The server stores the handle from a handle or the platform's own profile
  // link, and caps the website and the location; the inputs had no limit and
  // asked for a "username" only.
  it('takes a handle or a profile link in the social fields, within the server caps', () => {
    render(<CreatorProfileCard initialProfile={profile} loadError={null} />);

    for (const label of [/x \(twitter\) handle/i, /instagram handle/i, /tiktok handle/i]) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('placeholder', '@username or profile link');
      expect(input).toHaveAttribute('maxLength', '200');
    }
    expect(screen.getByLabelText(/website/i)).toHaveAttribute('maxLength', '2048');
    expect(screen.getByLabelText(/location/i)).toHaveAttribute('maxLength', '80');
  });

  it("draws the server's refusal of a social field under that field", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'Please fix the highlighted fields.',
        fieldErrors: { instagramHandle: 'Enter your Instagram username or profile link.' },
      }),
    } as Response);
    render(<CreatorProfileCard initialProfile={profile} loadError={null} />);
    fireEvent.change(screen.getByLabelText(/instagram handle/i), {
      target: { value: 'https://example.com/luna' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Enter your Instagram username or profile link.')).toBeInTheDocument();
    expect(screen.getByLabelText(/instagram handle/i)).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(screen.getByLabelText(/instagram handle/i)).toHaveFocus());
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

  // Answers an avatar upload as the server does, and the PATCH with `patch`.
  function answerAvatarSave(patch: () => Promise<Response>) {
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
            uploadId: 'profile-upload-1',
            path: 'test-user-id/avatar-server-issued.png',
            token: 'profile-upload-token',
            signedUploadUrl: 'https://storage.example.test/profile-upload-token',
            publicUrl: 'https://cdn.example.com/test-user-id/avatar-server-issued.png',
            expiresInSeconds: 7200,
          }),
        } as Response;
      }

      if (url.endsWith('/api/uploads/finalize')) {
        return {
          ok: true,
          json: async () => ({
            bucket: 'profiles',
            path: 'test-user-id/avatar-server-issued.png',
            storagePath: 'profiles/test-user-id/avatar-server-issued.png',
            contentType: 'image/png',
            sizeBytes: 6,
          }),
        } as Response;
      }

      if (url.endsWith('/api/profile')) {
        return patch();
      }

      if (url.endsWith('/api/profile/media/cleanup')) {
        return {
          ok: true,
          json: async () => ({ success: true }),
        } as Response;
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });
    return fetchMock;
  }

  function saveWithNewAvatar() {
    render(
      <CreatorProfileCard
        initialProfile={profile}
        loadError={null}
      />
    );

    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(fileInputs[0], {
      target: { files: [file] },
    });
    fireEvent.submit(screen.getByRole('button', { name: /save changes/i }).closest('form')!);
    return file;
  }

  const cleanupCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/profile/media/cleanup'));
  const patchCalls = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => (
    String(url).endsWith('/api/profile') && (init as RequestInit | undefined)?.method === 'PATCH'
  ));

  // A 5xx, or no answer at all, can follow a PATCH that already pointed the
  // row at the new files; deleting them then left the profile with a dead
  // photo. Those are the server's reclaim job's to remove.
  it('keeps just-uploaded media when the profile save answers 5xx', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answerAvatarSave(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed to update profile.' }),
    } as Response));

    saveWithNewAvatar();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to update profile.');
    expect(patchCalls()).toHaveLength(1);
    expect(cleanupCalls()).toHaveLength(0);
  });

  it('keeps just-uploaded media when the profile save gets no answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answerAvatarSave(async () => {
      throw new TypeError('Failed to fetch');
    });

    saveWithNewAvatar();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to update profile.');
    expect(patchCalls()).toHaveLength(1);
    expect(cleanupCalls()).toHaveLength(0);
  });

  it('removes newly uploaded media if the profile patch is refused after upload', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1712345678901);
    const fetchMock = answerAvatarSave(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'That username is already taken.',
        fieldErrors: {
          username: 'That username is already taken.',
        },
      }),
    } as Response));

    const file = saveWithNewAvatar();

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
