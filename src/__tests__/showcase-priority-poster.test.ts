import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const unstableCacheMock = vi.hoisted(() => vi.fn());

vi.mock('next/cache', () => ({
  unstable_cache: unstableCacheMock,
}));

const VALID_POSTER_URL = 'https://project.supabase.co/storage/v1/object/public/showcase_media/posts/post-1/0/cover.preview.abcdef0123456789.webp';
const VALID_SIGNED_GENERATED_PREVIEW_URL = 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/generation-1/cover.preview.abcdef0123456789.webp?token=signed-token';

function createWebpBytes(payloadBytes = 8): Uint8Array {
  const bytes = new Uint8Array(12 + payloadBytes);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  return bytes;
}

describe('showcase priority poster inlining', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    unstableCacheMock.mockReset();
    unstableCacheMock.mockImplementation((loader: (...args: unknown[]) => unknown) => loader);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('accepts only bounded public showcase or signed generated previews', async () => {
    const { isInlineableShowcasePriorityPoster } = await import('@/lib/showcase-priority-poster');

    expect(isInlineableShowcasePriorityPoster(VALID_POSTER_URL)).toBe(true);
    expect(isInlineableShowcasePriorityPoster(VALID_SIGNED_GENERATED_PREVIEW_URL)).toBe(true);
    expect(isInlineableShowcasePriorityPoster(
      'https://other.example/storage/v1/object/public/showcase_media/posts/post-1/cover.preview.abcdef0123456789.webp'
    )).toBe(false);
    expect(isInlineableShowcasePriorityPoster(
      'https://user:password@project.supabase.co/storage/v1/object/public/showcase_media/posts/post-1/cover.preview.abcdef0123456789.webp'
    )).toBe(false);
    expect(isInlineableShowcasePriorityPoster(
      'https://project.supabase.co/storage/v1/object/sign/showcase_media/posts/post-1/cover.preview.abcdef0123456789.webp'
    )).toBe(false);
    expect(isInlineableShowcasePriorityPoster(
      'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/generation-1/cover.preview.abcdef0123456789.webp'
    )).toBe(false);
    expect(isInlineableShowcasePriorityPoster(
      `${VALID_SIGNED_GENERATED_PREVIEW_URL}&download=1`
    )).toBe(false);
    expect(isInlineableShowcasePriorityPoster(
      `${VALID_SIGNED_GENERATED_PREVIEW_URL}&token=second-token`
    )).toBe(false);
    expect(isInlineableShowcasePriorityPoster(
      'https://project.supabase.co/storage/v1/object/public/profile_media/cover.preview.abcdef0123456789.webp'
    )).toBe(false);
    expect(isInlineableShowcasePriorityPoster(
      'https://project.supabase.co/storage/v1/object/public/showcase_media/posts/post-1/cover.webp'
    )).toBe(false);
    expect(isInlineableShowcasePriorityPoster(`${VALID_POSTER_URL}?token=unexpected`)).toBe(false);
    expect(isInlineableShowcasePriorityPoster(`${VALID_POSTER_URL}#fragment`)).toBe(false);
  });

  it('fetches without redirects and converts a bounded WebP response into a data URL', async () => {
    const bytes = createWebpBytes();
    const fetchMock = vi.fn(async () => new Response(Uint8Array.from(bytes), {
      status: 200,
      headers: {
        'content-length': String(bytes.byteLength),
        'content-type': 'image/webp; charset=binary',
      },
    }));
    const { fetchInlineShowcasePriorityPoster } = await import('@/lib/showcase-priority-poster');

    await expect(fetchInlineShowcasePriorityPoster(
      VALID_POSTER_URL,
      fetchMock as unknown as typeof fetch
    )).resolves.toBe(`data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`);
    expect(fetchMock).toHaveBeenCalledWith(VALID_POSTER_URL, expect.objectContaining({
      cache: 'no-store',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }));
  });

  it('rejects non-WebP responses and invalid file signatures', async () => {
    const { fetchInlineShowcasePriorityPoster } = await import('@/lib/showcase-priority-poster');
    const pngFetch = vi.fn(async () => new Response(Uint8Array.from(createWebpBytes()), {
      headers: { 'content-type': 'image/png' },
    }));
    const invalidWebpFetch = vi.fn(async () => new Response(Uint8Array.from({ length: 16 }, () => 0), {
      headers: { 'content-type': 'image/webp' },
    }));

    await expect(fetchInlineShowcasePriorityPoster(
      VALID_POSTER_URL,
      pngFetch as unknown as typeof fetch
    )).rejects.toThrow('image/webp');
    await expect(fetchInlineShowcasePriorityPoster(
      VALID_POSTER_URL,
      invalidWebpFetch as unknown as typeof fetch
    )).rejects.toThrow('WebP signature');
  });

  it('rejects declared and streamed bodies above 64 KiB', async () => {
    const {
      SHOWCASE_PRIORITY_POSTER_MAX_BYTES,
      fetchInlineShowcasePriorityPoster,
    } = await import('@/lib/showcase-priority-poster');
    const declaredOversizeFetch = vi.fn(async () => new Response(Uint8Array.from(createWebpBytes()), {
      headers: {
        'content-length': String(SHOWCASE_PRIORITY_POSTER_MAX_BYTES + 1),
        'content-type': 'image/webp',
      },
    }));
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(createWebpBytes(40_000));
        controller.enqueue(new Uint8Array(30_000));
        controller.close();
      },
    });
    const streamedOversizeFetch = vi.fn(async () => new Response(oversizedStream, {
      headers: { 'content-type': 'image/webp' },
    }));

    await expect(fetchInlineShowcasePriorityPoster(
      VALID_POSTER_URL,
      declaredOversizeFetch as unknown as typeof fetch
    )).rejects.toThrow('inline size limit');
    await expect(fetchInlineShowcasePriorityPoster(
      VALID_POSTER_URL,
      streamedOversizeFetch as unknown as typeof fetch
    )).rejects.toThrow('inline size limit');
  });

  it('aborts an origin request after 1.5 seconds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_src: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })
    ));
    const {
      SHOWCASE_PRIORITY_POSTER_TIMEOUT_MS,
      fetchInlineShowcasePriorityPoster,
    } = await import('@/lib/showcase-priority-poster');

    const result = fetchInlineShowcasePriorityPoster(
      VALID_POSTER_URL,
      fetchMock as unknown as typeof fetch
    );
    const settledResult = result.then(
      () => null,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(SHOWCASE_PRIORITY_POSTER_TIMEOUT_MS);

    await expect(settledResult).resolves.toMatchObject({ name: 'AbortError' });
  });

  it('uses a 24-hour argument-keyed cache and degrades fetch failures to null', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('origin unavailable');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getInlineShowcasePriorityPoster } = await import('@/lib/showcase-priority-poster');

    expect(unstableCacheMock).toHaveBeenCalledWith(
      expect.any(Function),
      ['showcase-priority-poster-v1'],
      { revalidate: 86_400 }
    );
    await expect(getInlineShowcasePriorityPoster(VALID_POSTER_URL)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
