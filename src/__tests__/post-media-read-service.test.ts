import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parsePrivatePostMediaPath, readPostMedia } from '@/lib/post-media-read-service';

const root = 'private-posts/b9100000-0000-4000-8000-000000000001/';
function client(path: string | null) {
  const rpc = vi.fn(async () => ({ data: path, error: null }));
  const sign = vi.fn(async () => ({ data: { signedUrl: `https://storage.test/${path}` }, error: null }));
  const from = vi.fn(() => ({ createSignedUrl: sign }));
  return { admin: { rpc, storage: { from } } as unknown as SupabaseClient, rpc, sign, from };
}
describe('post media authorization and signing', () => {
  it.each(['', 'private-posts/invalid/a', root + '../secret', root + '%252fsecret', root + 'a\\b'])('rejects ambiguous path %s', (path) => {
    expect(parsePrivatePostMediaPath(path)).toBeNull();
  });
  it('accepts canonical originals and legacy purchase aliases', () => {
    expect(parsePrivatePostMediaPath(root + 'photo.jpg')).toBe(root + 'photo.jpg');
    expect(parsePrivatePostMediaPath((root + 'photo.jpg').slice(8))).toBe((root + 'photo.jpg').slice(8));
  });
  it('never signs a rejected read', async () => {
    const { admin, sign } = client(null);
    expect(await readPostMedia({ admin, path: root + 'denied.jpg', viewerUserId: null })).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });
  it('shares only signing work; every read rechecks authorization including cache hits', async () => {
    const path = root + 'cached.jpg';
    const { admin, rpc, sign, from } = client(path);
    await Promise.all([1, 2, 3].map(() => readPostMedia({ admin, path, viewerUserId: 'viewer' })));
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(path, 120);
    expect(from).toHaveBeenCalledWith('post_media');
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await readPostMedia({ admin, path, viewerUserId: 'viewer' })).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it('signs the verified private target of an immutable old purchase alias', async () => {
    const path = root + 'purchased.jpg';
    const { admin, sign } = client(path);
    await readPostMedia({ admin, path: path.slice(8), viewerUserId: 'buyer' });
    expect(sign).toHaveBeenCalledWith(path, 120);
  });
});
