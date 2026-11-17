import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProfileShareButton from '@/components/ProfileShareButton';

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

  // The link carries the surface it was shared from, as a post's does, so the
  // creator page can credit the visit it brings (the app's links already do).
  it('uses the native share sheet for creator profile links when available', async () => {
    const shareUrl = `${window.location.origin}/creators/creator-name?s=creator-profile`;
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
        title: 'Creator Name on Magic Booklet',
        text: "Browse Creator Name's creator profile on Magic Booklet.",
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

  it('copies your own profile link, marked as shared from your profile, when native sharing is unavailable', async () => {
    const shareUrl = `${window.location.origin}/creators/creator-name?s=profile`;
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

  // A refused clipboard left "Sharing failed. Try again.", and trying again was refused the same
  // way (2026-11-17): the link comes up to copy by hand instead, and Copy link is a press of its own.
  it('offers the link to copy by hand where the browser refuses the clipboard, and counts it once copied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const link = `${window.location.origin}/creators/creator-name?s=creator-profile`;
    writeTextMock.mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'));
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    });

    render(
      <ProfileShareButton
        username="creator-name"
        displayName="Creator Name"
        sourceSurface="creator-profile"
        accessToken="token-1"
        className="inline-flex"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /share profile/i }));

    const sheet = await screen.findByRole('dialog', { name: 'Copy the link' });
    expect(within(sheet).getByRole('textbox', { name: 'Link' })).toHaveValue(link);
    expect(screen.queryByText('Sharing failed. Try again.')).toBeNull();
    expect(readProfileShareCall()).toBeNull();

    writeTextMock.mockReset();
    writeTextMock.mockResolvedValue(undefined);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writeTextMock).toHaveBeenCalledWith(link);
    expect(screen.getByRole('button', { name: /copied link/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(readProfileShareCall()).toMatchObject({
        headers: { Authorization: 'Bearer token-1' },
        body: { username: 'creator-name', sourceSurface: 'creator-profile', channel: 'copy-link' },
      });
    });
  });

  it('stays focusable while it shares, busy, and takes no second press meanwhile', async () => {
    shareMock.mockImplementation(() => new Promise<void>(() => undefined));
    Object.defineProperty(navigator, 'share', { configurable: true, value: shareMock });

    render(
      <ProfileShareButton
        username="creator-name"
        displayName="Creator Name"
        sourceSurface="creator-profile"
        className="inline-flex"
      />
    );
    const button = screen.getByRole('button', { name: /share profile/i });
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Sharing...' })).toBe(button);
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(shareMock).toHaveBeenCalledTimes(1);
  });
});
