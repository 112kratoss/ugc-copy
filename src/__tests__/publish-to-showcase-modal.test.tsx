import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';

const getSessionMock = vi.hoisted(() => vi.fn());

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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: true }),
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

    const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
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

    const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
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

    const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
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

    const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
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

    const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
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
