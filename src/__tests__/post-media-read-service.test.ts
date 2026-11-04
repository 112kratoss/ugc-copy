import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  PUBLIC_POST_MEDIA_SIGNATURE_TTL_SECONDS,
  parsePrivatePostMediaPath,
  readPostMedia,
  resetPostMediaSignaturesForTests,
} from '@/lib/post-media-read-service';

const postId = 'b9100000-0000-4000-8000-000000000001';
const root = `private-posts/${postId}/`;
const MINUTE = 60_000;

/**
 * `resolve_post_media_read` as the database answers it: `viewer` for the
 * signed-in reader, `anonymous` for someone signed out. A test changes either
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

const START = Date.parse('2026-11-04T12:00:00.000Z');
function clock() {
  let current = START;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

let logs: BackendLogRecord[] = [];
let restoreLogSink: () => void = () => undefined;
beforeEach(() => {
  resetPostMediaSignaturesForTests();
  logs = [];
  restoreLogSink = setBackendLogSink((record) => { logs.push(record); });
});
afterEach(() => restoreLogSink());

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
    expect(blocked.rpc).toHaveBeenCalledWith('resolve_post_media_read', { p_path: path, p_viewer_id: 'blocked-viewer' });
    expect(signedOut.rpc).toHaveBeenCalledTimes(1);
    expect(signedOut.sign).not.toHaveBeenCalled();
    expect(blocked.sign).not.toHaveBeenCalled();
  });

  it('asks the viewer\'s answer and the signed-out one side by side', async () => {
    const path = root + 'parallel.jpg';
    const { admin, rpc } = client({ viewer: path, anonymous: path });
    let releaseViewer: () => void = () => undefined;
    const viewerHeld = new Promise<void>((resolve) => { releaseViewer = resolve; });
    rpc.mockImplementation(async (_name, args) => {
      if (args.p_viewer_id !== null) await viewerHeld;
      return { data: path, error: null };
    });

    const read = readPostMedia({ admin, path, viewerUserId: 'viewer' });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(rpc.mock.calls.map(([, args]) => args.p_viewer_id)).toEqual(['viewer', null]);
    releaseViewer();
    await expect(read).resolves.toMatchObject({ browserCacheSeconds: expect.any(Number) });
  });
});

describe('media of a post anyone may read', () => {
  it('signs for 15 minutes and lets the browser keep the redirect until 2 minutes before it ends', async () => {
    const path = root + 'public.jpg';
    const { admin, rpc, sign, from } = client({ viewer: path, anonymous: path });
    const time = clock();

    const first = await readPostMedia({ admin, path, viewerUserId: null, now: time.now });

    expect(PUBLIC_POST_MEDIA_SIGNATURE_TTL_SECONDS).toBe(900);
    expect(sign).toHaveBeenCalledWith(path, 900);
    expect(from).toHaveBeenCalledWith('post_media');
    expect(first).toEqual({ signedUrl: `https://storage.test/${path}?ttl=900&n=1`, browserCacheSeconds: 780 });
    // Signed out, the one answer both authorizes and classifies the read.
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('hands the signature out again only while 5 of its minutes are left, rechecking every read', async () => {
    const path = root + 'reused.jpg';
    const { admin, rpc, sign } = client({ viewer: path, anonymous: path });
    const time = clock();

    await readPostMedia({ admin, path, viewerUserId: 'viewer', now: time.now });
    time.advance(9 * MINUTE);
    const later = await readPostMedia({ admin, path, viewerUserId: 'viewer', now: time.now });
    expect(sign).toHaveBeenCalledTimes(1);
    // The same capability, kept for what is left of it less the 2-minute margin.
    expect(later).toEqual({ signedUrl: `https://storage.test/${path}?ttl=900&n=1`, browserCacheSeconds: 240 });

    time.advance(MINUTE);
    const renewed = await readPostMedia({ admin, path, viewerUserId: 'viewer', now: time.now });
    expect(sign).toHaveBeenCalledTimes(2);
    expect(renewed).toEqual({ signedUrl: `https://storage.test/${path}?ttl=900&n=2`, browserCacheSeconds: 780 });
    // Signed in, each read asks for its viewer and for someone signed out.
    expect(rpc.mock.calls.map(([, args]) => args.p_viewer_id)).toEqual([
      'viewer', null, 'viewer', null, 'viewer', null,
    ]);
  });

  it('never hands out a link with under 5 minutes left, nor lets a kept redirect run within 2 minutes of its end', async () => {
    const path = root + 'margin.jpg';
    const { admin, sign } = client({ viewer: path, anonymous: path });
    const time = clock();
    const signedAt: number[] = [];
    sign.mockImplementation(async (signedPath: string, ttl: number) => {
      signedAt.push(time.now());
      return { data: { signedUrl: `https://storage.test/${signedPath}?ttl=${ttl}&n=${signedAt.length}` }, error: null };
    });

    for (let minute = 0; minute < 30; minute += 1) {
      const read = await readPostMedia({ admin, path, viewerUserId: null, now: time.now });
      const expiresAt = signedAt[Number(new URL(read!.signedUrl).searchParams.get('n')) - 1] + 15 * MINUTE;
      const keptUntil = time.now() + read!.browserCacheSeconds * 1000;
      expect(expiresAt - time.now()).toBeGreaterThan(5 * MINUTE);
      expect(read!.browserCacheSeconds).toBeGreaterThanOrEqual(60);
      expect(expiresAt - keptUntil).toBeGreaterThanOrEqual(2 * MINUTE);
      time.advance(MINUTE);
    }
    // Signed again every 10 minutes: at 0, 10 and 20.
    expect(signedAt).toEqual([0, 10, 20].map((minute) => START + minute * MINUTE));
  });

  it('lets no browser keep a redirect that could be kept for under a minute', async () => {
    const path = root + 'slow-signing.jpg';
    const { admin, sign } = client({ viewer: path, anonymous: path });
    const time = clock();
    // Signing that took 12.5 minutes leaves 30 seconds before the margin.
    sign.mockImplementation(async (signedPath: string, ttl: number) => {
      time.advance(12.5 * MINUTE);
      return { data: { signedUrl: `https://storage.test/${signedPath}?ttl=${ttl}` }, error: null };
    });

    await expect(readPostMedia({ admin, path, viewerUserId: null, now: time.now })).resolves.toEqual({
      signedUrl: `https://storage.test/${path}?ttl=900`,
      browserCacheSeconds: 0,
    });
  });

  it('refuses the next read of a post that left public view, without reusing the signature still kept', async () => {
    const path = root + 'left-public-view.jpg';
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

  it('never puts an alias in the public class, even when its signed-out answer is its private target', async () => {
    const alias = `posts/${postId}/cover.jpg`;
    const target = root + 'cover.jpg';
    // The legacy branch answers an alias by a looser owner rule than the
    // private path, so its signed-out answer can name the target while the
    // target itself is not public.
    const { admin, rpc, sign } = client({ viewer: target, anonymous: target });

    const buyerRead = await readPostMedia({ admin, path: alias, viewerUserId: 'buyer' });
    const signedOutRead = await readPostMedia({ admin, path: alias, viewerUserId: null });

    expect(buyerRead).toEqual({ signedUrl: `https://storage.test/${target}?ttl=120&n=1`, browserCacheSeconds: 0 });
    expect(signedOutRead?.browserCacheSeconds).toBe(0);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(target, 120);
    // Nothing to classify: an alias is restricted whatever the answer.
    expect(rpc.mock.calls.map(([, args]) => args)).toEqual([
      { p_path: alias, p_viewer_id: 'buyer' },
      { p_path: alias, p_viewer_id: null },
    ]);
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

  it('never gives a restricted read the public signature of an object that was public a moment ago', async () => {
    const path = root + 'made-private.jpg';
    const { admin, answers, sign } = client({ viewer: path, anonymous: path });
    const time = clock();
    const publicRead = await readPostMedia({ admin, path, viewerUserId: 'owner', now: time.now });
    expect(publicRead?.browserCacheSeconds).toBe(780);

    answers.anonymous = null;
    const ownerRead = await readPostMedia({ admin, path, viewerUserId: 'owner', now: time.now });

    expect(sign).toHaveBeenLastCalledWith(path, 120);
    expect(ownerRead).toEqual({ signedUrl: `https://storage.test/${path}?ttl=120&n=2`, browserCacheSeconds: 0 });
  });

  it('serves a read whose classification fails as restricted, never refused, and logs it', async () => {
    const path = root + 'unclassified.jpg';
    const { admin, rpc, sign } = client({ viewer: path, anonymous: path });
    rpc.mockImplementation(async (_name, args) => (args.p_viewer_id === null
      ? { data: null, error: { message: 'classification unavailable' } } as never
      : { data: path, error: null }));

    const read = await readPostMedia({ admin, path, viewerUserId: 'viewer' });

    expect(sign).toHaveBeenCalledWith(path, 120);
    expect(read?.browserCacheSeconds).toBe(0);
    expect(logs).toEqual([expect.objectContaining({
      level: 'error',
      msg: 'post_media_public_classification_failed',
    })]);
  });

  it('treats a viewer answer other than the path asked for as restricted', async () => {
    const path = root + 'asked.jpg';
    const { admin, sign } = client({ viewer: root + 'other.jpg', anonymous: path });

    const read = await readPostMedia({ admin, path, viewerUserId: 'viewer' });

    expect(sign).toHaveBeenCalledWith(root + 'other.jpg', 120);
    expect(read?.browserCacheSeconds).toBe(0);
  });

  it('fails the read when the viewer\'s own authorization cannot be read', async () => {
    const path = root + 'unavailable.jpg';
    const { admin, rpc, sign } = client({ viewer: path, anonymous: path });
    rpc.mockImplementation(async (_name, args) => (args.p_viewer_id === null
      ? { data: path, error: null }
      : { data: null, error: { message: 'database unavailable' } } as never));

    await expect(readPostMedia({ admin, path, viewerUserId: 'viewer' })).rejects.toMatchObject({ message: 'database unavailable' });
    expect(sign).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });
});
