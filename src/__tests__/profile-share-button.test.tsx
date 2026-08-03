import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProfileShareButton from '@/app/components/ProfileShareButton';

describe('ProfileShareButton', () => {
  const shareMock = vi.fn();
  const writeTextMock = vi.fn();
  const fetchMock = vi.fn();

  beforeEach(() => {
    shareMock.mockReset();
    writeTextMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true })));
    vi.stubGlobal('fetch', fetchMock);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function readProfileShareCall() {
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/profile/share');
    if (!call) return null;
    const init = call[1] as RequestInit;
    return {
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    };
  }

  it('uses the native share sheet for creator profile links when available', async () => {
    const shareUrl = `${window.location.origin}/creators/creator-name`;
    shareMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: shareMock,
    });

    render(
      <ProfileShareButton
        username="Creator-Name"
        displayName="Creator Name"
        sourceSurface="creator-profile"
        accessToken="token-1"
        className="inline-flex"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /share profile/i }));

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledWith({
        title: 'Creator Name on magicbooklet',
        text: "Browse Creator Name's creator profile on magicbooklet.",
        url: shareUrl,
      });
    });

    expect(await screen.findByRole('button', { name: /shared/i })).toBeInTheDocument();
    // Profile shares used to be recorded nowhere on either platform, so creator
    // reach was unmeasurable.
    await waitFor(() => {
      expect(readProfileShareCall()).toMatchObject({
        headers: { Authorization: 'Bearer token-1' },
        body: { username: 'Creator-Name', sourceSurface: 'creator-profile', channel: 'native-share' },
      });
    });
  });

  it('copies the creator profile link when native sharing is unavailable', async () => {
    const shareUrl = `${window.location.origin}/creators/creator-name`;
    writeTextMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    });

    render(
      <ProfileShareButton
        username="@Creator-Name"
        displayName="Creator Name"
        sourceSurface="profile"
        className="inline-flex"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /share profile/i }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(shareUrl);
    });

    expect(await screen.findByRole('button', { name: /copied link/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(readProfileShareCall()).toMatchObject({
        body: { sourceSurface: 'profile', channel: 'copy-link' },
      });
    });
  });

  it('records nothing when the viewer dismisses the share sheet', async () => {
    shareMock.mockRejectedValue(
      Object.assign(new DOMException('The user aborted a request.', 'AbortError'))
    );
    Object.defineProperty(navigator, 'share', { configurable: true, value: shareMock });

    render(
      <ProfileShareButton
        username="creator-name"
        displayName="Creator Name"
        sourceSurface="creator-profile"
        className="inline-flex"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /share profile/i }));

    await waitFor(() => expect(shareMock).toHaveBeenCalled());
    expect(readProfileShareCall()).toBeNull();
  });

  it('shows a retry state when sharing fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeTextMock.mockRejectedValue(new Error('Clipboard denied'));
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    });

    render(
      <ProfileShareButton
        username="creator-name"
        displayName="Creator Name"
        sourceSurface="creator-profile"
        className="inline-flex"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /share profile/i }));

    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByText('Sharing failed. Try again.')).toBeInTheDocument();
  });
});
