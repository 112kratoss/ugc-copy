import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import PublishToShowcaseModal from '@/components/PublishToShowcaseModal';
import { TITLE_MAX_LENGTH } from '@/lib/posts-server';

const getSessionMock = vi.hoisted(() => vi.fn());
const sharePublicGenerationMock = vi.hoisted(() => vi.fn());

function getPublishRequest(): RequestInit {
  const call = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/showcase/publish');
  if (!call) {
    throw new Error('Expected a showcase publish request.');
  }
  return call[1] as RequestInit;
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
    },
  },
}));

vi.mock('@/lib/share-client', () => ({
  sharePublicGeneration: sharePublicGenerationMock,
}));

describe('PublishToShowcaseModal', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    sharePublicGenerationMock.mockReset();
    sharePublicGenerationMock.mockResolvedValue('copy-link');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => new Response(
      JSON.stringify(String(url) === '/api/profile'
        ? {
            id: 'user-1',
            username: 'launchmaker',
            suggestedUsername: 'creator-a1b2c3d4',
            displayName: 'Launch Maker',
            bio: null,
            avatarUrl: 'https://cdn.example.com/avatar.jpg',
            coverUrl: null,
            websiteUrl: null,
            twitterHandle: null,
            instagramHandle: null,
            tiktokHandle: null,
            location: null,
            credits: 20,
          }
        : { success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('takes a title as long as the server allows, 100 characters', () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Broadcast"
      />
    );

    expect(TITLE_MAX_LENGTH).toBe(100);
    expect(screen.getByRole('textbox', { name: /^title$/i })).toHaveAttribute('maxlength', String(TITLE_MAX_LENGTH));
  });

  // Decision 18 (2026-10-17): the quick form stays, with a way into the full
  // composer for the same creation. The composer takes the creation from its
  // address and reads no title or caption there.
  it('links More options to the full composer for the same creation', () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Broadcast"
      />
    );

    expect(screen.getByRole('link', { name: 'More options' })).toHaveAttribute('href', '/post/new?generationId=gen-1');
  });

  it('does not leave for the composer while a publish is in flight', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => (
      String(url) === '/api/profile'
        ? new Response(JSON.stringify({
            id: 'user-1',
            username: 'launchmaker',
            displayName: 'Launch Maker',
            avatarUrl: 'https://cdn.example.com/avatar.jpg',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Promise<Response>(() => {})
    ));
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Broadcast"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^private post$/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/showcase/publish', expect.anything()));

    const moreOptions = screen.getByRole('link', { name: 'More options' });
    expect(moreOptions).toHaveAttribute('aria-disabled', 'true');
    // A click that went through would post the creation a second time.
    expect(fireEvent.click(moreOptions)).toBe(false);
  });

  it('keeps a long creation title within the post limit so the publish is not refused', async () => {
    const creationTitle = `${'Golden hour rooftop portrait '.repeat(5)}with city lights`;
    expect(creationTitle.length).toBeGreaterThan(TITLE_MAX_LENGTH);
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle={creationTitle}
      />
    );

    // The field's maxlength does not trim a value it is handed.
    expect(screen.getByRole('textbox', { name: /^title$/i })).toHaveValue(creationTitle.slice(0, TITLE_MAX_LENGTH));
    fireEvent.click(screen.getByRole('button', { name: /^private post$/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/showcase/publish', expect.anything());
    });
    expect(JSON.parse(String(getPublishRequest().body)).title).toBe(creationTitle.slice(0, TITLE_MAX_LENGTH));
  });

  it('keeps the publish dialog scrollable within the viewport', () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Broadcast"
      />
    );

    const dialog = screen.getByRole('dialog', { name: /publish this creation/i });
    const overlay = dialog.parentElement;

    expect(overlay).toHaveClass('overflow-y-auto');
    expect(dialog).toHaveClass('max-h-[calc(100vh-3rem)]');
    expect(dialog).toHaveClass('overflow-y-auto');
  });

  it('contains focus, closes with Escape, and restores focus to the opener', async () => {
    function Harness() {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setIsOpen(true)}>Open publish</button>
          <PublishToShowcaseModal
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            generationId="gen-1"
            defaultTitle="Broadcast"
          />
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: /open publish/i });
    opener.focus();
    fireEvent.click(opener);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /^title$/i })).toHaveFocus();
    });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('does not dismiss while a publish request is still completing', async () => {
    let resolvePublish: ((response: Response) => void) | null = null;
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      if (String(url) === '/api/profile') {
        return new Response(JSON.stringify({
          id: 'user-1',
          username: 'launchmaker',
          displayName: 'Launch Maker',
          avatarUrl: 'https://cdn.example.com/avatar.jpg',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Promise<Response>((resolve) => {
        resolvePublish = resolve;
      });
    });
    const onClose = vi.fn();

    render(
      <PublishToShowcaseModal
        isOpen
        onClose={onClose}
        generationId="gen-1"
        defaultTitle="Broadcast"
      />
    );

    await screen.findByText(/ready for public publishing/i);
    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));
    await waitFor(() => expect(resolvePublish).not.toBeNull());

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog').parentElement!);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /close publish dialog/i })).toBeDisabled();

    resolvePublish!(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps a successful publish successful when the optional share action fails', async () => {
    sharePublicGenerationMock.mockRejectedValueOnce(new Error('Share sheet unavailable'));
    const onPublished = vi.fn();
    const onClose = vi.fn();

    render(
      <PublishToShowcaseModal
        isOpen
        onClose={onClose}
        onPublished={onPublished}
        generationId="gen-1"
        defaultTitle="Broadcast"
        shareAfterPublish={{
          title: 'Broadcast',
          description: 'Finished creation',
          sourceSurface: 'my-creations',
        }}
      />
    );

    await screen.findByText(/ready for public publishing/i);
    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    await waitFor(() => {
      expect(onPublished).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(sharePublicGenerationMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/share sheet unavailable/i)).not.toBeInTheDocument();
  });

  // A new account has the placeholder handle and no name, which a public post
  // is refused for. The window asks for both and saves them as part of the
  // public post, where it used to send the creator to their profile.
  describe('a name and handle before a public post', () => {
    const placeholderProfile = {
      id: 'user-1',
      username: 'creator-a1b2c3d4',
      suggestedUsername: 'creator-a1b2c3d4',
      displayName: null,
      avatarUrl: null,
    };

    function answer(handlers: { patchProfile?: () => Response }) {
      vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === '/api/profile' && init?.method === 'PATCH') {
          return handlers.patchProfile?.() ?? new Response(JSON.stringify({
            ...placeholderProfile,
            ...JSON.parse(String(init.body)),
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(
          JSON.stringify(String(url) === '/api/profile' ? placeholderProfile : { success: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
    }
    const calls = (url: string, method?: string) => vi.mocked(fetch).mock.calls
      .filter(([called, init]) => String(called) === url && (method ? init?.method === method : true));

    it('asks for them and publishes nothing publicly until they are given, while Private post still goes', async () => {
      answer({});
      render(<PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="Broadcast" />);

      expect(await screen.findByRole('textbox', { name: /^display name$/i })).toHaveValue('');
      expect(screen.queryByRole('link', { name: /complete profile/i })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Add your name and handle to publish publicly.');
      expect(screen.getByText('Add a display name for your public profile.')).toBeInTheDocument();
      expect(calls('/api/profile', 'PATCH')).toHaveLength(0);
      expect(calls('/api/showcase/publish')).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: /^private post$/i }));
      await waitFor(() => expect(calls('/api/showcase/publish')).toHaveLength(1));
      expect(calls('/api/profile', 'PATCH')).toHaveLength(0);
    });

    it('saves them, then publishes, in one press', async () => {
      answer({});
      render(<PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="Broadcast" />);

      fireEvent.change(await screen.findByRole('textbox', { name: /^display name$/i }), { target: { value: 'Maya K' } });
      fireEvent.change(screen.getByRole('textbox', { name: /^handle$/i }), { target: { value: '@Maya-K' } });
      fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

      await waitFor(() => expect(calls('/api/showcase/publish')).toHaveLength(1));
      const [patch] = calls('/api/profile', 'PATCH');
      expect(JSON.parse(String(patch[1]?.body))).toEqual({ username: 'maya-k', displayName: 'Maya K' });
      const order = vi.mocked(fetch).mock.invocationCallOrder;
      const patchIndex = vi.mocked(fetch).mock.calls.indexOf(patch);
      const publishIndex = vi.mocked(fetch).mock.calls.findIndex(([url]) => url === '/api/showcase/publish');
      expect(order[patchIndex]).toBeLessThan(order[publishIndex]);
      expect(JSON.parse(String(getPublishRequest().body)).visibility).toBe('public');
    });

    it('shows a taken handle on its field and publishes nothing', async () => {
      answer({
        patchProfile: () => new Response(JSON.stringify({
          error: 'That username is already taken.',
          fieldErrors: { username: 'That username is already taken.' },
        }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
      });
      render(<PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="Broadcast" />);

      fireEvent.change(await screen.findByRole('textbox', { name: /^display name$/i }), { target: { value: 'Maya K' } });
      fireEvent.change(screen.getByRole('textbox', { name: /^handle$/i }), { target: { value: 'maya' } });
      fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

      await waitFor(() => expect(screen.getByRole('textbox', { name: /^handle$/i })).toHaveAttribute('aria-invalid', 'true'));
      expect(screen.getAllByText('That username is already taken.').length).toBeGreaterThanOrEqual(1);
      expect(calls('/api/showcase/publish')).toHaveLength(0);
      expect(screen.getByRole('button', { name: /^public post$/i })).toBeEnabled();
    });

    // The profile is read again at the press: a handle claimed in another tab
    // since the window opened is never replaced by the window's older values.
    it('saves nothing over a profile finished meanwhile, and publishes', async () => {
      answer({});
      render(<PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="Broadcast" />);
      fireEvent.change(await screen.findByRole('textbox', { name: /^display name$/i }), { target: { value: 'Maya K' } });
      fireEvent.change(screen.getByRole('textbox', { name: /^handle$/i }), { target: { value: 'maya-k' } });

      vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => new Response(
        JSON.stringify(String(url) === '/api/profile'
          ? { ...placeholderProfile, username: 'maya', displayName: 'Maya' }
          : { success: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
      fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

      await waitFor(() => expect(calls('/api/showcase/publish')).toHaveLength(1));
      expect(calls('/api/profile', 'PATCH')).toHaveLength(0);
      expect(JSON.parse(String(getPublishRequest().body)).visibility).toBe('public');
    });
  });

  it('says whom a public post goes out as when the profile is ready', async () => {
    render(<PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="Broadcast" />);
    expect(await screen.findByText('Posting as Launch Maker · @launchmaker')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^display name$/i })).toBeNull();
  });

  // Most creations have no title; typing one was the step people stopped at.
  describe('the title of a creation that has none', () => {
    const creation = {
      prompt: 'A product still lit like a window display. Soft morning light.',
      model: 'nano-banana-2',
      category: 'image',
    };
    const prefill = {
      resourceKinds: ['prompt' as const],
      promptText: creation.prompt,
      notesMarkdown: null,
      allowRemix: false,
    };

    it('starts from a suggestion cut from the prompt and says so', () => {
      render(<PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="" creation={creation} />);
      expect(screen.getByRole('textbox', { name: /^title$/i })).toHaveValue('Product still lit like a window display');
      expect(screen.getByText('Suggested from your prompt. Edit it if you like.')).toBeInTheDocument();
    });

    it('swaps an untouched suggestion while a recipe keeps the prompt private, and keeps a typed title', () => {
      const { unmount } = render(
        <PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="" creation={creation} paywallPrefill={prefill} />,
      );
      const title = screen.getByRole('textbox', { name: /^title$/i });
      fireEvent.click(screen.getByRole('radio', { name: 'Paid' }));
      expect(title).toHaveValue('Image recipe');
      fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
      expect(title).toHaveValue('Product still lit like a window display');
      unmount();

      render(
        <PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="" creation={creation} paywallPrefill={prefill} />,
      );
      const typed = screen.getByRole('textbox', { name: /^title$/i });
      fireEvent.change(typed, { target: { value: 'Window still' } });
      fireEvent.click(screen.getByRole('radio', { name: 'Paid' }));
      expect(typed).toHaveValue('Window still');
    });

    it('keeps the creation’s own title', () => {
      render(<PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="Broadcast" creation={creation} />);
      expect(screen.getByRole('textbox', { name: /^title$/i })).toHaveValue('Broadcast');
      expect(screen.queryByText(/^Suggested/)).toBeNull();
    });

    // The motion page reads a creation's details after the window can open.
    it('suggests nothing until the creation’s details arrive, then fills the empty title', () => {
      const { rerender } = render(
        <PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="" creation={null} />,
      );
      const title = screen.getByRole('textbox', { name: /^title$/i });
      expect(title).toHaveValue('');

      rerender(<PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="" creation={creation} />);
      expect(title).toHaveValue('Product still lit like a window display');
    });

    it('keeps what the creator typed and chose when the details arrive late', () => {
      const { rerender } = render(
        <PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="" creation={null} paywallPrefill={prefill} />,
      );
      const title = screen.getByRole('textbox', { name: /^title$/i });
      fireEvent.change(title, { target: { value: 'Window still' } });
      fireEvent.click(screen.getByRole('radio', { name: 'Paid' }));

      rerender(
        <PublishToShowcaseModal isOpen onClose={vi.fn()} generationId="gen-1" defaultTitle="" creation={creation} paywallPrefill={prefill} />,
      );
      expect(title).toHaveValue('Window still');
      expect(screen.getByRole('radio', { name: 'Paid' })).toBeChecked();
    });
  });

  it('uses the caller access token when publishing instead of loading a Supabase session', async () => {
    const onClose = vi.fn();

    render(
      <PublishToShowcaseModal
        isOpen
        onClose={onClose}
        generationId="gen-1"
        defaultTitle="Broadcast"
        accessToken="layout-session-token"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/showcase/publish', expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer layout-session-token',
        }),
      }));
    });

    expect(getSessionMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps visibility as final public or private actions', async () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Broadcast"
      />
    );

    expect(screen.queryByText(/^visibility$/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /unlisted/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^private post$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^public post$/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^private post$/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/showcase/publish', expect.objectContaining({
        body: expect.any(String),
      }));
    });

    const request = getPublishRequest();
    const body = JSON.parse(String(request.body));

    expect(body.visibility).toBe('private');
  });

  it('publishes media-only template results without recipe fields and returns the stable Feed path', async () => {
    const onPublished = vi.fn();
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => new Response(
      JSON.stringify(String(url) === '/api/profile'
        ? {
            id: 'user-1',
            username: 'launchmaker',
            displayName: 'Launch Maker',
            avatarUrl: 'https://cdn.example.com/avatar.jpg',
          }
        : {
            success: true,
            visibility: 'public',
            postId: 'post-template-1',
            showcasePath: '/showcase/post-template-1',
            ownerPath: '/post/post-template-1/edit',
          }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="template-result-1"
        defaultTitle="Rider transformation"
        showPaidShortcut={false}
        mediaOnly
        onPublished={onPublished}
      />
    );

    expect(screen.getByText(/share it to Explore or keep it private/i)).toBeInTheDocument();
    expect(screen.queryByText(/saved system package/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/share the prompt and setup/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Paid' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({
      visibility: 'public',
      postId: 'post-template-1',
      showcasePath: '/showcase/post-template-1',
      ownerPath: '/post/post-template-1/edit',
    })));

    const request = getPublishRequest();
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      generationId: 'template-result-1',
      visibility: 'public',
      shareInputMediaForRemix: false,
    });
    expect(body).not.toHaveProperty('resourceBundle');
    expect(body).not.toHaveProperty('includeGenerationReferences');
    expect(body).not.toHaveProperty('exposePromptPublic');
    expect(body).not.toHaveProperty('prompt');
  });

  // The caption is the post's public description. The recipe's generated
  // setup notes belong to the bundle, not the caption; prefilling them here
  // published "Saved generation setup / Model: …" as the caption of every
  // quick publish that did not clear the field.
  it('starts the caption empty rather than prefilling the recipe notes', () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Moody portrait setup"
        paywallPrefill={{
          resourceKinds: ['prompt', 'notes', 'remix'],
          promptText: 'Create a moody editorial portrait with soft bathroom light and natural pose.',
          notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0\nAspect ratio: 4:5',
          allowRemix: true,
        }}
      />
    );

    expect(screen.getByRole('textbox', { name: /caption optional/i })).toHaveValue('');
    expect(screen.queryByRole('textbox', { name: /notes/i })).toBeNull();
  });

  it('keeps the generation description as the caption default', () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Moody portrait setup"
        defaultDescription="  Shot at golden hour.  "
        paywallPrefill={{
          resourceKinds: ['notes'],
          promptText: null,
          notesMarkdown: 'Saved generation setup',
          allowRemix: false,
        }}
      />
    );

    expect(screen.getByRole('textbox', { name: /caption optional/i })).toHaveValue('Shot at golden hour.');
  });

  it('can publish a generated paid unlock from saved generation data', async () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Moody portrait setup"
        accessToken="layout-session-token"
        paywallPrefill={{
          resourceKinds: ['prompt', 'notes', 'remix'],
          promptText: 'Create a moody editorial portrait with soft bathroom light and natural pose.',
          notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0\nAspect ratio: 4:5',
          allowRemix: true,
        }}
      />
    );

    expect(screen.queryByRole('button', { name: /advanced edit/i })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Paid' }));
    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/showcase/publish', expect.objectContaining({
        body: expect.any(String),
      }));
    });

    const request = getPublishRequest();
    const body = JSON.parse(String(request.body));

    expect(body).toMatchObject({
      generationId: 'gen-1',
      visibility: 'public',
      resourceBundle: {
        accessMode: 'paid',
        priceUsdCents: 900,
        resources: {
          promptText: 'Create a moody editorial portrait with soft bathroom light and natural pose.',
          notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0\nAspect ratio: 4:5',
          allowRemix: true,
        },
      },
    });
  });

  it('publishes a free recipe without asking for a price', async () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Moody portrait setup"
        accessToken="layout-session-token"
        paywallPrefill={{
          resourceKinds: ['prompt', 'notes', 'remix'],
          promptText: 'Create a moody editorial portrait with soft bathroom light and natural pose.',
          notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0\nAspect ratio: 4:5',
          allowRemix: true,
        }}
      />
    );

    expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: 'Free' }));

    expect(screen.getByRole('radio', { name: 'Free' })).toBeChecked();
    expect(screen.queryByRole('textbox', { name: /recipe price/i })).not.toBeInTheDocument();
    expect(screen.getByText(/free recipe/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/showcase/publish', expect.objectContaining({
        body: expect.any(String),
      }));
    });

    const body = JSON.parse(String(getPublishRequest().body));

    expect(body).toMatchObject({
      generationId: 'gen-1',
      visibility: 'public',
      resourceBundle: {
        accessMode: 'free',
        priceUsdCents: 0,
        resources: {
          promptText: 'Create a moody editorial portrait with soft bathroom light and natural pose.',
          notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0\nAspect ratio: 4:5',
          allowRemix: true,
        },
      },
    });
  });

  it('does not require a seller avatar to publish a free recipe', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => new Response(
      JSON.stringify(String(url) === '/api/profile'
        ? {
            id: 'user-1',
            username: 'launchmaker',
            suggestedUsername: 'creator-a1b2c3d4',
            displayName: 'Launch Maker',
            avatarUrl: null,
          }
        : { success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Moody portrait setup"
        paywallPrefill={{
          resourceKinds: ['prompt', 'notes'],
          promptText: 'Create a moody editorial portrait.',
          notesMarkdown: 'Saved generation setup',
          allowRemix: false,
        }}
      />
    );

    await screen.findByText(/ready for public publishing/i);
    fireEvent.click(screen.getByRole('radio', { name: 'Free' }));

    // A free recipe stays on the public-publish gate, so the avatar-less
    // profile is still considered ready.
    expect(screen.getByText(/ready for public publishing/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/showcase/publish')).toBe(true);
    });

    expect(JSON.parse(String(getPublishRequest().body))).toMatchObject({
      resourceBundle: { accessMode: 'free' },
    });
  });

  it('does not require a seller avatar to publish a paid recipe', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => new Response(
      JSON.stringify(String(url) === '/api/profile'
        ? {
            id: 'user-1',
            username: 'launchmaker',
            suggestedUsername: 'creator-a1b2c3d4',
            displayName: 'Launch Maker',
            avatarUrl: null,
          }
        : { success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Moody portrait setup"
        paywallPrefill={{
          resourceKinds: ['prompt', 'notes'],
          promptText: 'Create a moody editorial portrait.',
          notesMarkdown: 'Saved generation setup',
          allowRemix: false,
        }}
      />
    );

    await screen.findByText(/ready for public publishing/i);
    fireEvent.click(screen.getByRole('radio', { name: 'Paid' }));

    // A missing profile photo never blocks publishing — paid recipes use the
    // same public gate (handle + display name) as everything else.
    expect(screen.getByText(/ready for public publishing/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/showcase/publish')).toBe(true);
    });

    expect(JSON.parse(String(getPublishRequest().body))).toMatchObject({
      resourceBundle: { accessMode: 'paid' },
    });
  });

  it('keeps saved generation references private for media-only publishing', async () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Reference portrait setup"
        accessToken="layout-session-token"
        paywallPrefill={{
          resourceKinds: ['prompt', 'notes', 'files'],
          promptText: 'Create the portrait using the saved reference images.',
          notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0',
          allowRemix: false,
          referenceCount: 2,
          referenceKindCounts: {
            image: 2,
          },
        }}
      />
    );

    expect(screen.getByText(/2 references included/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/showcase/publish', expect.objectContaining({
        body: expect.any(String),
      }));
    });

    const request = getPublishRequest();
    const body = JSON.parse(String(request.body));

    expect(body).toMatchObject({
      generationId: 'gen-1',
      visibility: 'public',
      resourceBundle: {
        accessMode: 'none',
      },
    });
    expect(body).not.toHaveProperty('includeGenerationReferences');
  });

  it('does not require a seller avatar for a media-only post with private references', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => new Response(
      JSON.stringify(String(url) === '/api/profile'
        ? {
            id: 'user-1',
            username: 'launchmaker',
            suggestedUsername: 'creator-a1b2c3d4',
            displayName: 'Launch Maker',
            avatarUrl: null,
          }
        : { success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Reference portrait setup"
        paywallPrefill={{
          resourceKinds: ['files'],
          allowRemix: false,
          promptText: null,
          notesMarkdown: null,
          referenceCount: 1,
          referenceKindCounts: { image: 1 },
        }}
      />
    );

    expect(await screen.findByText(/ready for public publishing/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/showcase/publish')).toBe(true);
    });
  });
});
