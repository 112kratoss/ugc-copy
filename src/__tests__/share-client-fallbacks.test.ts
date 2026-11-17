import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ShareLinkRefusedError,
  copyCreatorProfileLink,
  copyPublicGenerationLink,
  shareCreatorProfile,
  sharePublicGeneration,
} from '@/lib/share-client';

const ORIGIN = window.location.origin;

// Every way a share from the web can go: through the share sheet, dismissed there, refused there
// and copied instead, refused by the clipboard too, or with no share sheet at all. A share is
// counted (`/api/showcase/share`, `/api/profile/share`) only where one happened. Where the browser
// refuses the link both ways (an in-app browser's or a webview's sheet that fails, after which the
// clipboard refuses a write whose click the sheet has spent: "Write permission denied" in an
// embedded Chromium, 2026-11-17), the link comes back on the error for the person to copy by hand,
// and the copy's own press is counted once it has put the link on the clipboard.
describe.each([
  {
    kind: 'a post',
    share: () => sharePublicGeneration({
      generationId: 'post-1', title: 'Shared creation', sourceSurface: 'feed', accessToken: 'token',
    }),
    copyByHand: (url: string) => copyPublicGenerationLink({
      url, generationId: 'post-1', sourceSurface: 'feed', accessToken: 'token',
    }),
    link: `${ORIGIN}/showcase/post-1?s=feed`,
    countPath: '/api/showcase/share',
    count: (channel: string) => ({ generationId: 'post-1', sourceSurface: 'feed', channel }),
  },
  {
    kind: 'a creator profile',
    share: () => shareCreatorProfile({
      username: 'creator-name', displayName: 'Creator Name', sourceSurface: 'creator-profile', accessToken: 'token',
    }),
    copyByHand: (url: string) => copyCreatorProfileLink({
      url, username: 'creator-name', sourceSurface: 'creator-profile', accessToken: 'token',
    }),
    link: `${ORIGIN}/creators/creator-name?s=creator-profile`,
    countPath: '/api/profile/share',
    count: (channel: string) => ({ username: 'creator-name', sourceSurface: 'creator-profile', channel }),
  },
])('sharing $kind', ({ share, copyByHand, link, countPath, count }) => {
  const shareSheet = vi.fn<(data: ShareData) => Promise<void>>();
  const writeText = vi.fn<(text: string) => Promise<void>>();
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  /** The shares counted, by where they were sent and what they said. */
  const counted = () => fetchMock.mock.calls.map(([input, init]) => ({
    path: String(input),
    body: JSON.parse(String(init?.body)) as unknown,
  }));

  const refusedBy = (name: string) => new DOMException(`${name} from the browser`, name);

  beforeEach(() => {
    shareSheet.mockReset();
    shareSheet.mockResolvedValue(undefined);
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(navigator, 'share', { configurable: true, value: shareSheet });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'share');
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('shares through the share sheet, and counts it as shared there', async () => {
    await expect(share()).resolves.toBe('native-share');

    expect(shareSheet).toHaveBeenCalledWith(expect.objectContaining({ url: link }));
    expect(writeText).not.toHaveBeenCalled();
    expect(counted()).toEqual([{ path: countPath, body: count('native-share') }]);
  });

  it('counts nothing, and copies nothing, when the person dismisses the share sheet', async () => {
    shareSheet.mockRejectedValue(refusedBy('AbortError'));

    await expect(share()).resolves.toBeNull();

    expect(writeText).not.toHaveBeenCalled();
    expect(counted()).toEqual([]);
  });

  it('copies the link where the share sheet refuses it and the clipboard takes it', async () => {
    shareSheet.mockRejectedValue(refusedBy('NotAllowedError'));

    await expect(share()).resolves.toBe('copy-link');

    expect(writeText).toHaveBeenCalledWith(link);
    expect(counted()).toEqual([{ path: countPath, body: count('copy-link') }]);
  });

  it('hands the link back, counting nothing, where the share sheet and the clipboard both refuse it', async () => {
    shareSheet.mockRejectedValue(refusedBy('NotAllowedError'));
    const clipboardRefusal = refusedBy('NotAllowedError');
    writeText.mockRejectedValue(clipboardRefusal);

    const refusal = await share().then(() => null, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(ShareLinkRefusedError);
    expect((refusal as ShareLinkRefusedError).url).toBe(link);
    expect((refusal as ShareLinkRefusedError).cause).toBe(clipboardRefusal);
    expect(counted()).toEqual([]);
  });

  it('copies the link where the browser has no share sheet', async () => {
    Reflect.deleteProperty(navigator, 'share');

    await expect(share()).resolves.toBe('copy-link');

    expect(writeText).toHaveBeenCalledWith(link);
    expect(counted()).toEqual([{ path: countPath, body: count('copy-link') }]);
  });

  it('hands the link back where the browser has no share sheet and refuses the clipboard', async () => {
    Reflect.deleteProperty(navigator, 'share');
    writeText.mockRejectedValue(refusedBy('NotAllowedError'));

    const refusal = await share().then(() => null, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(ShareLinkRefusedError);
    expect((refusal as ShareLinkRefusedError).url).toBe(link);
    expect(counted()).toEqual([]);
  });

  it('hands the link back where the browser has neither a share sheet nor a clipboard', async () => {
    Reflect.deleteProperty(navigator, 'share');
    Reflect.deleteProperty(navigator, 'clipboard');

    const refusal = await share().then(() => null, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(ShareLinkRefusedError);
    expect((refusal as ShareLinkRefusedError).url).toBe(link);
    expect(counted()).toEqual([]);
  });

  describe('copied by hand', () => {
    it('puts the link on the clipboard, then counts a copied link', async () => {
      await copyByHand(link);

      expect(writeText).toHaveBeenCalledWith(link);
      await vi.waitFor(() => expect(counted()).toEqual([{ path: countPath, body: count('copy-link') }]));
    });

    it('throws, counting nothing, where the clipboard refuses even a press of its own', async () => {
      writeText.mockRejectedValue(refusedBy('NotAllowedError'));

      await expect(copyByHand(link)).rejects.toThrow();

      expect(counted()).toEqual([]);
    });

    it('throws, counting nothing, where the browser has no clipboard', async () => {
      Reflect.deleteProperty(navigator, 'clipboard');

      await expect(copyByHand(link)).rejects.toThrow();

      expect(counted()).toEqual([]);
    });
  });
});
