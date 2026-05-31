import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

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

    const dialog = screen.getByRole('dialog', { name: /add this creation to your portfolio/i });
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

    fireEvent.click(screen.getByRole('button', { name: /^add to portfolio$/i }));

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
});
