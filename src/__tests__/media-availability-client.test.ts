import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkMediaAvailability, MEDIA_AVAILABILITY_TIMEOUT_MS } from '@/lib/media-availability-client';

const API_MEDIA = '/api/media?bucket=post_media&path=private-posts%2Fpost-1%2Fphoto.jpg';
const PUBLIC_COPY = 'https://project.supabase.co/storage/v1/object/public/showcase_media/public-posts/post-1/photo.jpg';

function answer(status: number) {
  return new Response(JSON.stringify({ error: 'x' }), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('checkMediaAvailability', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('asks the failed address itself, uncached and without following a redirect', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer(404));

    await checkMediaAvailability(API_MEDIA, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(input).toBe(API_MEDIA);
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'manual' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  // The media route refuses a read the post no longer allows (archived,
  // private, hidden, marked NSFW, its owner gone) with 404; Storage answers a
  // public copy removed with its post's public reading with 400 (NoSuchKey).
  it.each([
    ['the media route refusing the read', API_MEDIA, 404],
    ['Storage no longer holding the public copy', PUBLIC_COPY, 400],
    ['a 410', PUBLIC_COPY, 410],
  ])('is gone on %s', async (_case, url, status) => {
    const fetchImpl = vi.fn(async () => answer(status));

    await expect(checkMediaAvailability(url, { fetchImpl })).resolves.toBe('gone');
  });

  it('is readable when the media route would redirect to the file', async () => {
    const redirect = { type: 'opaqueredirect', status: 0, ok: false, body: null } as unknown as Response;
    const fetchImpl = vi.fn(async () => redirect);

    await expect(checkMediaAvailability(API_MEDIA, { fetchImpl })).resolves.toBe('readable');
  });

  it('is readable when the file answers, and stops reading it', async () => {
    const response = new Response('image bytes', { status: 200 });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetchImpl = vi.fn(async () => response);

    await expect(checkMediaAvailability(PUBLIC_COPY, { fetchImpl })).resolves.toBe('readable');
    expect(cancel).toHaveBeenCalled();
  });

  // A refused session or a busy server says nothing of the post: a feed is
  // never emptied on those.
  it.each([401, 403, 429, 500, 503])('is unknown on %i', async (status) => {
    const fetchImpl = vi.fn(async () => answer(status));

    await expect(checkMediaAvailability(API_MEDIA, { fetchImpl })).resolves.toBe('unknown');
  });

  it('is unknown when the request itself fails (offline)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(checkMediaAvailability(API_MEDIA, { fetchImpl })).resolves.toBe('unknown');
  });

  it('gives up as unknown when no answer comes in time', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const result = checkMediaAvailability(API_MEDIA, { fetchImpl });
    await vi.advanceTimersByTimeAsync(MEDIA_AVAILABILITY_TIMEOUT_MS);

    await expect(result).resolves.toBe('unknown');
  });

  it('asks once for an address while an answer is on its way, and again after it arrives', async () => {
    let respond!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      respond = resolve;
    }));

    const first = checkMediaAvailability(API_MEDIA, { fetchImpl });
    const second = checkMediaAvailability(API_MEDIA, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    respond(answer(404));
    await expect(first).resolves.toBe('gone');
    await expect(second).resolves.toBe('gone');

    const third = checkMediaAvailability(API_MEDIA, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    respond(answer(503));
    await expect(third).resolves.toBe('unknown');
  });
});
