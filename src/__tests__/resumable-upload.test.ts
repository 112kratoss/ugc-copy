import { expect, it, vi } from 'vitest';
import { signedResumableTarget, uploadResumable } from '../../ugc-mobile/lib/media-upload/resumable';
it('keeps signed uploads on the capability endpoint without user JWT or upsert', async () => {
  const target = signedResumableTarget('https://project.supabase.co/storage/v1/object/upload/sign/uploads/owner/file.mp4?token=capability')!;
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => options?.method === 'POST'
    ? new Response(null, { status: 201, headers: { Location: target.endpoint + '/session' } })
    : new Response(null, { status: 204, headers: { 'Upload-Offset': '4' } }));
  await uploadResumable({ target, size: 4, contentType: 'video/mp4', fetchImpl, readChunk: () => new Uint8Array(4) });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ 'x-signature': 'capability', 'x-upsert': 'false' });
  expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
});
