import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';

const getSessionMock = vi.hoisted(() => vi.fn());

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

describe('PublishToShowcaseModal', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
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

  it('blocks public publishing with an actionable profile repair link but keeps private save available', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => new Response(
      JSON.stringify(String(url) === '/api/profile'
        ? {
            id: 'user-1',
            username: 'creator-a1b2c3d4',
            suggestedUsername: 'creator-a1b2c3d4',
            displayName: null,
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
        defaultTitle="Broadcast"
      />
    );

    const repairLink = await screen.findByRole('link', { name: /complete profile in a new tab/i });
    expect(repairLink).toHaveAttribute('href', '/profile?source=quick-publish');
    expect(repairLink).toHaveAttribute('target', '_blank');

    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/custom handle/i);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/showcase/publish')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /^private post$/i }));
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/showcase/publish')).toBe(true);
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

  it('prefills notes from the saved generation setup when no description exists', () => {
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

    expect(screen.getByRole('textbox', { name: /notes optional/i })).toHaveValue(
      'Saved generation setup\nModel: Nano Banana 2.0\nAspect ratio: 4:5'
    );
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

    fireEvent.click(screen.getByRole('checkbox', { name: /sell the prompt and setup/i }));
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

  it('includes saved generation references when publishing from the simple Studio modal', async () => {
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
      includeGenerationReferences: true,
      resourceBundle: {
        accessMode: 'none',
      },
    });
  });

  it('requires seller readiness when public references become a free unlock', async () => {
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
          referenceCount: 1,
          referenceKindCounts: { image: 1 },
        }}
      />
    );

    expect(await screen.findByText(/seller profile needs attention/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/profile photo/i);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/showcase/publish')).toBe(false);
  });

  it('opens unlock management with the saved package selected', async () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Moody portrait setup"
        accessToken="layout-session-token"
        initialSellAutoUnlock
        paywallPrefill={{
          resourceKinds: ['prompt', 'notes', 'remix'],
          promptText: 'Create a moody editorial portrait with soft bathroom light and natural pose.',
          notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0\nAspect ratio: 4:5',
          allowRemix: true,
        }}
      />
    );

    expect(screen.getByRole('checkbox', { name: /sell the prompt and setup/i })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /^private post$/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/showcase/publish', expect.objectContaining({
        body: expect.any(String),
      }));
    });

    const request = getPublishRequest();
    const body = JSON.parse(String(request.body));

    expect(body).toMatchObject({
      generationId: 'gen-1',
      visibility: 'private',
      resourceBundle: {
        accessMode: 'paid',
        priceUsdCents: 900,
      },
    });
  });

  it('removes an existing unlock when saving from unlock management with pricing off', async () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Moody portrait setup"
        accessToken="layout-session-token"
        initialSellAutoUnlock
        paywallPrefill={{
          resourceKinds: ['prompt', 'notes', 'remix'],
          promptText: 'Create a moody editorial portrait with soft bathroom light and natural pose.',
          notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0\nAspect ratio: 4:5',
          allowRemix: true,
        }}
      />
    );

    const sellPackageCheckbox = screen.getByRole('checkbox', { name: /sell the prompt and setup/i });
    expect(sellPackageCheckbox).toBeChecked();

    fireEvent.click(sellPackageCheckbox);
    expect(sellPackageCheckbox).not.toBeChecked();
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
  });
});
