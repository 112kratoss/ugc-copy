import { describe, expect, it, vi } from 'vitest';

import {
  CACHED_PAGE_MEDIA_SIGNATURE_SECONDS,
  mediaSignatureSeconds,
  withCachedPageMediaSignatures,
} from '@/lib/media-signature-scope';
import { resolveOwnedStoredMediaUrl } from '@/lib/server-helpers';

const OWNER_ID = '10000000-0000-4000-8000-000000000001';

function storageClient() {
  const createSignedUrl = vi.fn(async (filePath: string, seconds: number) => ({
    data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/generated_images/${filePath}?expires=${seconds}` },
    error: null,
  }));
  return { admin: { storage: { from: vi.fn(() => ({ createSignedUrl })) } } as never, createSignedUrl };
}

describe('how long a signed media link lasts', () => {
  // A cached page is served for up to an hour after it was drawn, from data
  // read up to five minutes before that, and the client router keeps it five
  // more: two hours outlives every copy.
  it('outlives every cached copy of a public page', () => {
    expect(CACHED_PAGE_MEDIA_SIGNATURE_SECONDS).toBeGreaterThan(3600 + 300 + 300);
  });

  it("is the caller's own outside a cached page's read, and two hours inside it, across awaits", async () => {
    expect(mediaSignatureSeconds(3600)).toBe(3600);

    await withCachedPageMediaSignatures(async () => {
      await Promise.resolve();
      expect(mediaSignatureSeconds(3600)).toBe(CACHED_PAGE_MEDIA_SIGNATURE_SECONDS);
      // A caller that asks for longer keeps it.
      expect(mediaSignatureSeconds(24 * 3600)).toBe(24 * 3600);
    });

    expect(mediaSignatureSeconds(3600)).toBe(3600);
  });

  it("signs a creator's own file for an hour, and for two inside a cached page's read", async () => {
    const { admin, createSignedUrl } = storageClient();
    const path = `generated_images/${OWNER_ID}/output.png`;

    await resolveOwnedStoredMediaUrl(admin, path, OWNER_ID);
    await withCachedPageMediaSignatures(() => resolveOwnedStoredMediaUrl(admin, path, OWNER_ID));

    expect(createSignedUrl.mock.calls).toEqual([
      [`${OWNER_ID}/output.png`, 3600],
      [`${OWNER_ID}/output.png`, CACHED_PAGE_MEDIA_SIGNATURE_SECONDS],
    ]);
  });
});
