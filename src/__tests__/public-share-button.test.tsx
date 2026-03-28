import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PublicShareButton from '@/app/components/PublicShareButton';

describe('PublicShareButton', () => {
  const fetchMock = vi.fn();
  const shareMock = vi.fn();
  const writeTextMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    shareMock.mockReset();
    writeTextMock.mockReset();

    vi.stubGlobal('fetch', fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses native share when available and records the share click', async () => {
    const shareUrl = `${window.location.origin}/showcase/gen-1`;
    shareMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: shareMock,
    });

    render(
      <PublicShareButton
        generationId="gen-1"
        title="Public creation"
        description="A polished creator prompt"
        sourceSurface="showcase"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /share/i }));

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledWith({
        title: 'Public creation',
        text: 'A polished creator prompt',
        url: shareUrl,
      });
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/showcase/share', expect.objectContaining({
        method: 'POST',
      }));
    });

    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload).toMatchObject({
      generationId: 'gen-1',
      sourceSurface: 'showcase',
      channel: 'native-share',
    });
  });

  it('falls back to clipboard copy when navigator.share is unavailable', async () => {
    const shareUrl = `${window.location.origin}/showcase/gen-2`;
    writeTextMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    });

    render(
      <PublicShareButton
        generationId="gen-2"
        title="Public creation"
        sourceSurface="creator-profile"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /share/i }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(shareUrl);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/showcase/share', expect.objectContaining({
        method: 'POST',
      }));
    });

    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload).toMatchObject({
      generationId: 'gen-2',
      sourceSurface: 'creator-profile',
      channel: 'copy-link',
    });
    expect(screen.getByRole('button', { name: /copied link/i })).toBeInTheDocument();
  });
});
