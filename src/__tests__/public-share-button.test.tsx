import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PublicShareButton from '@/components/PublicShareButton';

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
    // The shared URL carries `?s=<surface>`; the in-app path deliberately does
    // not. That marker is what tells a real share visit apart from a bookmark or
    // a search result, and attributes it back to the surface it came from.
    const shareUrl = `${window.location.origin}/showcase/gen-1?s=showcase`;
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
        text: 'See "Public creation" on Magic Booklet',
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

  it('does not leak long prompt text into the native share sheet', async () => {
    shareMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: shareMock,
    });

    render(
      <PublicShareButton
        generationId="gen-3"
        title="Hero still"
        description="This is a deliberately long prompt-like description that should never be sent through the share sheet as the body text."
        sourceSurface="showcase"
        viewerIsOwner
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /share/i }));

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Hero still',
        text: 'Look what I created on Magic Booklet: Hero still',
      }));
    });
  });

  it('falls back to clipboard copy when navigator.share is unavailable', async () => {
    const shareUrl = `${window.location.origin}/showcase/gen-2?s=creator-profile`;
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

  // A disabled button gives up the focus, so a keyboard or screen-reader user who pressed Share
  // landed at the top of the page (2026-11-17). Busy, it stays a button they are on. (That the
  // browser keeps the focus there is tests/e2e/share-button-focus.spec.ts: jsdom moves no focus
  // off a disabled button.)
  it('stays focusable while it shares, busy, and takes no second press meanwhile', async () => {
    let finishShare = () => {};
    shareMock.mockImplementation(() => new Promise<void>((resolve) => {
      finishShare = resolve;
    }));
    Object.defineProperty(navigator, 'share', { configurable: true, value: shareMock });

    render(<PublicShareButton generationId="gen-5" title="Public creation" sourceSurface="feed" />);
    const button = screen.getByRole('button', { name: 'Share' });
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Sharing...' })).toBe(button);
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(shareMock).toHaveBeenCalledTimes(1);

    await act(async () => finishShare());
    expect(await screen.findByRole('button', { name: 'Shared' })).not.toHaveAttribute('aria-disabled');
  });

  it('stays disabled where the post cannot be shared at all', () => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: shareMock });

    render(
      <PublicShareButton
        generationId="gen-6"
        title="Private creation"
        sourceSurface="feed"
        disabled
        disabledReason="Only public posts can be shared"
      />
    );
    const button = screen.getByRole('button', { name: 'Share' });
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Only public posts can be shared');
    expect(shareMock).not.toHaveBeenCalled();
  });

  // Where the share sheet refused the link, the clipboard was asked after the sheet had spent the
  // click, and refused too: "Sharing failed. Try again.", with no way to share at all. The link
  // comes up to copy by hand instead, and Copy link is a press of its own.
  describe('refused by the share sheet and the clipboard', () => {
    const link = `${window.location.origin}/showcase/gen-4?s=feed`;

    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      shareMock.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
      writeTextMock.mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'));
      Object.defineProperty(navigator, 'share', { configurable: true, value: shareMock });
    });

    async function refusedShare(onShared?: () => void) {
      render(<PublicShareButton generationId="gen-4" title="Public creation" sourceSurface="feed" onShared={onShared} />);
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
      return screen.findByRole('dialog', { name: 'Copy the link' });
    }

    it('offers the link to copy by hand, and counts the share once Copy link has put it on the clipboard', async () => {
      const onShared = vi.fn();
      const sheet = await refusedShare(onShared);

      const field = within(sheet).getByRole('textbox', { name: 'Link' });
      expect(field).toHaveValue(link);
      expect(field).toHaveAttribute('readonly');
      expect(screen.queryByText('Sharing failed. Try again.')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onShared).not.toHaveBeenCalled();

      writeTextMock.mockReset();
      writeTextMock.mockResolvedValue(undefined);
      fireEvent.click(within(sheet).getByRole('button', { name: 'Copy link' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(writeTextMock).toHaveBeenCalledWith(link);
      expect(onShared).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Copied link' })).toBeInTheDocument();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledWith('/api/showcase/share', expect.objectContaining({ method: 'POST' }));
      expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
        generationId: 'gen-4',
        sourceSurface: 'feed',
        channel: 'copy-link',
      });
    });

    it('says so, and counts nothing, where the clipboard refuses Copy link too', async () => {
      const onShared = vi.fn();
      const sheet = await refusedShare(onShared);

      fireEvent.click(within(sheet).getByRole('button', { name: 'Copy link' }));

      expect(await within(sheet).findByText('Copying is blocked here too. Select the link and copy it yourself.')).toBeInTheDocument();
      expect(within(sheet).getByRole('textbox', { name: 'Link' })).toHaveFocus();
      expect(screen.getByRole('dialog', { name: 'Copy the link' })).toBe(sheet);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onShared).not.toHaveBeenCalled();
    });

    it('counts one copy for a second press of Copy link while the clipboard answers the first', async () => {
      const onShared = vi.fn();
      const sheet = await refusedShare(onShared);
      let finishCopy = () => {};
      writeTextMock.mockReset();
      writeTextMock.mockImplementation(() => new Promise<void>((resolve) => {
        finishCopy = resolve;
      }));
      const copyLink = within(sheet).getByRole('button', { name: 'Copy link' });

      fireEvent.click(copyLink);
      fireEvent.click(copyLink);
      await act(async () => finishCopy());

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(writeTextMock).toHaveBeenCalledTimes(1);
      expect(onShared).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    });

    it('counts nothing when the sheet is put away, and Share is Share again', async () => {
      const sheet = await refusedShare();

      fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // A share button sits inside things that act on a press or a swipe of their own: a feed card
    // opens its post, the reel moves to another post. The sheet is drawn in <body>, but React's
    // events cross a portal, so none of the sheet's may reach them.
    it('keeps the sheet\'s presses and swipes from what the button sits in', async () => {
      const onCardClick = vi.fn();
      const onReelSwipe = vi.fn();
      render(
        <div onClick={onCardClick} onTouchStart={onReelSwipe} onTouchEnd={onReelSwipe} onWheel={onReelSwipe}>
          <PublicShareButton generationId="gen-4" title="Public creation" sourceSurface="feed" />
        </div>
      );
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
      const sheet = await screen.findByRole('dialog', { name: 'Copy the link' });
      const field = within(sheet).getByRole('textbox', { name: 'Link' });

      fireEvent.click(field);
      fireEvent.touchStart(field);
      fireEvent.touchEnd(field);
      fireEvent.wheel(field);
      // The backdrop's own press puts the sheet away, and goes no further either.
      fireEvent.click(sheet.parentElement as HTMLElement);

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(onCardClick).not.toHaveBeenCalled();
      expect(onReelSwipe).not.toHaveBeenCalled();
    });
  });
});
