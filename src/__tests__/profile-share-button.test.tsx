import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProfileShareButton from '@/app/components/ProfileShareButton';

describe('ProfileShareButton', () => {
  const shareMock = vi.fn();
  const writeTextMock = vi.fn();

  beforeEach(() => {
    shareMock.mockReset();
    writeTextMock.mockReset();

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
        className="inline-flex"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /share profile/i }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(shareUrl);
    });

    expect(await screen.findByRole('button', { name: /copied link/i })).toBeInTheDocument();
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
        className="inline-flex"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /share profile/i }));

    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByText('Sharing failed. Try again.')).toBeInTheDocument();
  });
});
