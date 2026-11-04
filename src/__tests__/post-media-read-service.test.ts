import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PUBLIC_POST_MEDIA_SIGNATURE_TTL_SECONDS,
  parsePrivatePostMediaPath,
  readPostMedia,
  resetPostMediaSignaturesForTests,
} from '@/lib/post-media-read-service';

const root = 'private-posts/b9100000-0000-4000-8000-000000000001/';
const MINUTE = 60_000;

/**
 * `resolve_post_media_read` as the database answers it: `viewer` for the
 * signed-in reader, `anonymous` for no viewer at all. A test changes either
 * between reads to stand for a post, block or purchase that changed meanwhile.
 */
function client(answers: { viewer: string | null; anonymous: string | null }) {
  const rpc = vi.fn(async (_name: string, args: { p_path: string; p_viewer_id: string | null }) => ({
    data: args.p_viewer_id === null ? answers.anonymous : answers.viewer,
    error: null,
  }));
  let signed = 0;
  const sign = vi.fn(async (path: string, ttl: number) => ({
    data: { signedUrl: `https://storage.test/${path}?ttl=${ttl}&n=${++signed}` },
    error: null,
  }));
  const from = vi.fn(() => ({ createSignedUrl: sign }));
  return { admin: { rpc, storage: { from } } as unknown as SupabaseClient, answers, rpc, sign, from };
}

function clock(start = Date.parse('2026-11-04T12:00:00.000Z')) {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

beforeEach(() => resetPostMediaSignaturesForTests());

describe('post media authorization and signing', () => {
  it.each(['', 'private-posts/invalid/a', root + '../secret', root + '%252fsecret', root + 'a\\b'])('rejects ambiguous path %s', (path) => {
    expect(parsePrivatePostMediaPath(path)).toBeNull();
  });

  it('accepts canonical originals and legacy purchase aliases', () => {
    expect(parsePrivatePostMediaPath(root + 'photo.jpg')).toBe(root + 'photo.jpg');
    expect(parsePrivatePostMediaPath((root + 'photo.jpg').slice(8))).toBe((root + 'photo.jpg').slice(8));
  });

  it('never signs a refused read, and refuses on the viewer\'s own answer alone', async () => {
    const path = root + 'denied.jpg';
    const signedOut = client({ viewer: null, anonymous: null });
    expect(await readPostMedia({ admin: signedOut.admin, path, viewerUserId: null })).toBeNull();
    // A viewer the creator blocked is refused even though anyone signed out may read it.
    const blocked = client({ viewer: null, anonymous: path });
    expect(await readPostMedia({ admin: blocked.admin, path, viewerUserId: 'blocked-viewer' })).toBeNull();
    expect(blocked.rpc).toHaveBeenCalledTimes(1);
    expect(blocked.rpc).toHaveBeenCalledWith('resolve_post_media_read', { p_path: path, p_viewer_id: 'blocked-viewer' });
    expect(signedOut.sign).not.toHaveBeenCalled();
    expect(blocked.sign).not.toHaveBeenCalled();
  });
});

describe('media of a post anyone may read', () => {
  it('signs for an hour and lets the browser keep the redirect until ten minutes before it ends', async () => {
    const path = root + 'public.jpg';
    const { admin, rpc, sign, from } = client({ viewer: path, anonymous: path });
    const time = clock();

    const first = await readPostMedia({ admin, path, viewerUserId: null, now: time.now });

    expect(sign).toHaveBeenCalledWith(path, PUBLIC_POST_MEDIA_SIGNATURE_TTL_SECONDS);
    expect(from).toHaveBeenCalledWith('post_media');
    expect(first).toEqual({ signedUrl: `https://storage.test/${path}?ttl=3600&n=1`, browserCacheSeconds: 3000 });
    // Signed out, the one answer both authorizes and classifies the read.
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('reuses the hour-long signature for its first 45 minutes, rechecking every read', async () => {
    const path = root + 'reused.jpg';
    const { admin, rpc, sign } = client({ viewer: path, anonymous: path });
    const time = clock();

    await readPostMedia({ admin, path, viewerUserId: 'viewer', now: time.now });
    time.advance(30 * MINUTE);
    const later = await readPostMedia({ admin, path, viewerUserId: 'viewer', now: time.now });
    expect(sign).toHaveBeenCalledTimes(1);
    // The same capability, kept for what is left of it short of the margin.
    expect(later).toEqual({ signedUrl: `https://storage.test/${path}?ttl=3600&n=1`, browserCacheSeconds: 1200 });

    time.advance(15 * MINUTE);
    const renewed = await readPostMedia({ admin, path, viewerUserId: 'viewer', now: time.now });
    expect(sign).toHaveBeenCalledTimes(2);
    expect(renewed).toEqual({ signedUrl: `https://storage.test/${path}?ttl=3600&n=2`, browserCacheSeconds: 3000 });
    // Signed in, each read asks for its viewer, then for no viewer.
    expect(rpc.mock.calls.map(([, args]) => args.p_viewer_id)).toEqual([
      'viewer', null, 'viewer', null, 'viewer', null,
    ]);
  });

  it('never lets a kept redirect outlive its signature by less than ten minutes', async () => {
    const path = root + 'margin.jpg';
    const { admin, sign } = client({ viewer: path, anonymous: path });
    const time = clock();
    const signedAt: number[] = [];
    sign.mockImplementation(async (signedPath: string, ttl: number) => {
      signedAt.push(time.now());
      return { data: { signedUrl: `https://storage.test/${signedPath}?ttl=${ttl}&n=${signedAt.length}` }, error: null };
    });

    for (let minute = 0; minute < 120; minute += 1) {
      const read = await readPostMedia({ admin, path, viewerUserId: null, now: time.now });
      const expiresAt = signedAt[Number(new URL(read!.signedUrl).searchParams.get('n')) - 1] + 60 * MINUTE;
      const keptUntil = time.now() + read!.browserCacheSeconds * 1000;
      expect(read!.browserCacheSeconds).toBeGreaterThanOrEqual(300);
      expect(expiresAt - keptUntil).toBeGreaterThanOrEqual(10 * MINUTE);
      time.advance(MINUTE);
    }
    // Signed again every 45 minutes: at 0, 45 and 90.
    expect(signedAt).toEqual([0, 45, 90].map((minute) => clock().now() + minute * MINUTE));
  });

  it('stops serving a post taken down at the very next read, kept signature or not', async () => {
    const path = root + 'taken-down.jpg';
    const { admin, answers, sign } = client({ viewer: path, anonymous: path });
    expect(await readPostMedia({ admin, path, viewerUserId: null })).not.toBeNull();

    answers.viewer = null;
    answers.anonymous = null;
    expect(await readPostMedia({ admin, path, viewerUserId: null })).toBeNull();
    expect(await readPostMedia({ admin, path, viewerUserId: 'viewer' })).toBeNull();
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('bounds the kept signatures', async () => {
    const { admin, answers, sign } = client({ viewer: null, anonymous: null });
    const paths = Array.from({ length: 257 }, (_, index) => `${root}bounded-${index}.jpg`);
    for (const path of paths) {
      answers.viewer = path;
      answers.anonymous = path;
      await readPostMedia({ admin, path, viewerUserId: null });
    }
    expect(sign).toHaveBeenCalledTimes(257);

    answers.viewer = paths[0];
    answers.anonymous = paths[0];
    await readPostMedia({ admin, path: paths[0], viewerUserId: null });
    expect(sign).toHaveBeenCalledTimes(258);
    answers.viewer = paths[256];
    answers.anonymous = paths[256];
    await readPostMedia({ admin, path: paths[256], viewerUserId: null });
    expect(sign).toHaveBeenCalledTimes(258);
  });
});

describe('media only some viewers may read', () => {
  it('keeps the owner\'s private post to a 120-second signature no cache may keep', async () => {
    const path = root + 'private.jpg';
    const { admin, sign } = client({ viewer: path, anonymous: null });
    const time = clock();

    const read = await readPostMedia({ admin, path, viewerUserId: 'owner', now: time.now });
    expect(sign).toHaveBeenCalledWith(path, 120);
    expect(read).toEqual({ signedUrl: `https://storage.test/${path}?ttl=120&n=1`, browserCacheSeconds: 0 });

    // Shared only for a minute, so every capability handed out has a minute left.
    time.advance(59_000);
    await readPostMedia({ admin, path, viewerUserId: 'owner', now: time.now });
    expect(sign).toHaveBeenCalledTimes(1);
    time.advance(1_000);
    await readPostMedia({ admin, path, viewerUserId: 'owner', now: time.now });
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('signs the verified private target of an immutable old purchase alias for 120 seconds', async () => {
    const path = root + 'purchased.jpg';
    const { admin, rpc, sign } = client({ viewer: path, anonymous: null });

    const read = await readPostMedia({ admin, path: path.slice(8), viewerUserId: 'buyer' });

    expect(rpc).toHaveBeenCalledWith('resolve_post_media_read', { p_path: path.slice(8), p_viewer_id: 'buyer' });
    expect(sign).toHaveBeenCalledWith(path, 120);
    expect(read?.browserCacheSeconds).toBe(0);
  });

  it('ends a buyer\'s access at the next read once the purchase is retracted', async () => {
    const path = root + 'snapshot.jpg';
    const { admin, answers, sign } = client({ viewer: path, anonymous: null });
    await Promise.all([1, 2, 3].map(() => readPostMedia({ admin, path, viewerUserId: 'buyer' })));
    expect(sign).toHaveBeenCalledTimes(1);

    answers.viewer = null;
    expect(await readPostMedia({ admin, path, viewerUserId: 'buyer' })).toBeNull();
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('never gives a restricted read the hour-long signature of an object that was public a moment ago', async () => {
    const path = root + 'made-private.jpg';
    const { admin, answers, sign } = client({ viewer: path, anonymous: path });
    const time = clock();
    const publicRead = await readPostMedia({ admin, path, viewerUserId: 'owner', now: time.now });
    expect(publicRead?.browserCacheSeconds).toBe(3000);

    answers.anonymous = null;
    const ownerRead = await readPostMedia({ admin, path, viewerUserId: 'owner', now: time.now });

    expect(sign).toHaveBeenLastCalledWith(path, 120);
    expect(ownerRead).toEqual({ signedUrl: `https://storage.test/${path}?ttl=120&n=2`, browserCacheSeconds: 0 });
  });

  it('serves a read whose classification fails as restricted, never refused', async () => {
    const path = root + 'unclassified.jpg';
    const { admin, rpc, sign } = client({ viewer: path, anonymous: path });
    rpc.mockImplementation(async (_name, args) => (args.p_viewer_id === null
      ? { data: null, error: { message: 'classification unavailable' } } as never
      : { data: path, error: null }));

    const read = await readPostMedia({ admin, path, viewerUserId: 'viewer' });

    expect(sign).toHaveBeenCalledWith(path, 120);
    expect(read?.browserCacheSeconds).toBe(0);
  });

  it('treats a viewer answer that differs from the anonymous one as restricted', async () => {
    const alias = 'posts/b9100000-0000-4000-8000-000000000001/cover.jpg';
    const { admin, sign } = client({ viewer: root + 'cover.jpg', anonymous: alias });

    const read = await readPostMedia({ admin, path: alias, viewerUserId: 'buyer' });

    expect(sign).toHaveBeenCalledWith(root + 'cover.jpg', 120);
    expect(read?.browserCacheSeconds).toBe(0);
  });

  it('fails the read when the viewer\'s own authorization cannot be read', async () => {
    const path = root + 'unavailable.jpg';
    const { admin, rpc, sign } = client({ viewer: path, anonymous: path });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'database unavailable' } } as never);

    await expect(readPostMedia({ admin, path, viewerUserId: 'viewer' })).rejects.toMatchObject({ message: 'database unavailable' });
    expect(sign).not.toHaveBeenCalled();
  });
});
