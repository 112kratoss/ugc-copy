import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ session: { access_token: 'session-1', expires_at: 10, user: { id: 'owner' } } }));
const loads = vi.hoisted(() => ({
  calls: [] as Array<{ uri: string; cacheKey?: string; headers?: Record<string, string> }>,
  /** The options each load was asked with, beside its source. */
  options: [] as Array<{ maxWidth?: number; maxHeight?: number } | undefined>,
  releases: 0,
  /** Each load waits for the test to finish it, in the order they were asked for. */
  pending: [] as Array<(outcome: 'loaded' | 'failed') => void>,
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => auth }));
vi.mock('@/lib/env', () => ({ env: { apiBaseUrl: 'https://magicbooklet.com', supabaseUrl: 'https://project.supabase.co' } }));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  Platform: platform,
}));
vi.mock('expo-image', () => ({
  Image: {
    loadAsync: (
      source: { uri: string; cacheKey?: string; headers?: Record<string, string> },
      options?: { maxWidth?: number; maxHeight?: number },
    ) => {
      loads.calls.push(source);
      loads.options.push(options);
      return new Promise((resolve, reject) => {
        loads.pending.push((outcome) => (outcome === 'loaded'
          ? resolve({ release: () => { loads.releases += 1; } })
          : reject(new Error('offline'))));
      });
    },
  },
}));

import { useMediaSource } from '../lib/use-media-source';

type WarmupModule = typeof import('../lib/media-image-warmup');
let warmup: WarmupModule;

/** Lets every queued load reach `loadAsync` that can. */
async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

async function finishNext(outcome: 'loaded' | 'failed' = 'loaded') {
  const next = loads.pending.shift();
  expect(next).toBeTypeOf('function');
  next!(outcome);
  await settle();
}

beforeEach(async () => {
  // A fresh module per test: what it has asked for is kept for the whole launch.
  vi.resetModules();
  warmup = await import('../lib/media-image-warmup');
  loads.calls = [];
  loads.options = [];
  loads.releases = 0;
  loads.pending = [];
  platform.OS = 'ios';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('warmImages', () => {
  it("asks expo-image for each picture under the tile's own cache key, and lets the decoded picture go", async () => {
    warmup.warmImages([{ url: 'https://cdn.example.com/a.webp', cacheKey: 'tile-a' }], 'session-1');
    await settle();

    expect(loads.calls).toEqual([{ uri: 'https://cdn.example.com/a.webp', cacheKey: 'tile-a' }]);
    await finishNext();
    expect(loads.releases).toBe(1);
  });

  // fd29cc597 (2026-08-23): overlapping first loadAsync calls crashed iOS.
  it('loads one picture at a time, across warm-ups', async () => {
    warmup.warmImages([
      { url: 'https://cdn.example.com/a.webp', cacheKey: 'a' },
      { url: 'https://cdn.example.com/b.webp', cacheKey: 'b' },
    ], null);
    warmup.warmImages([{ url: 'https://cdn.example.com/c.webp', cacheKey: 'c' }], null);
    await settle();
    expect(loads.calls.map((call) => call.cacheKey)).toEqual(['a']);

    await finishNext('failed');
    expect(loads.calls.map((call) => call.cacheKey)).toEqual(['a', 'b']);
    await finishNext();
    expect(loads.calls.map((call) => call.cacheKey)).toEqual(['a', 'b', 'c']);
    await finishNext();
    expect(loads.pending).toHaveLength(0);
  });

  it('asks for each picture once a launch, loaded or not', async () => {
    const pictures = [
      { url: 'https://cdn.example.com/a.webp', cacheKey: 'a' },
      { url: 'https://cdn.example.com/b.webp', cacheKey: 'b' },
    ];
    warmup.warmImages(pictures, null);
    await settle();
    await finishNext();
    await finishNext('failed');

    warmup.warmImages([...pictures, { url: 'https://cdn.example.com/c.webp', cacheKey: 'c' }], null);
    await settle();
    expect(loads.calls.map((call) => call.uri)).toEqual([
      'https://cdn.example.com/a.webp',
      'https://cdn.example.com/b.webp',
      'https://cdn.example.com/c.webp',
    ]);
  });

  // Every read of a library signs its files anew. expo-image finds a picture by
  // the key it is cached under, so a new signature under a known key is a
  // picture already on the disk, and asking again only decodes it again.
  it('does not ask again for a picture whose link was only signed again', async () => {
    const signed = (signature: string) => `https://project.supabase.co/storage/v1/object/sign/generated_images/owner/a.webp?token=${signature}`;
    warmup.warmImages([{ url: signed('first-read'), cacheKey: 'owner/previews/a.webp' }], null);
    await settle();
    await finishNext();

    warmup.warmImages([{ url: signed('second-read'), cacheKey: 'owner/previews/a.webp' }], null);
    await settle();
    expect(loads.calls.map((call) => call.uri)).toEqual([signed('first-read')]);
  });

  // Android decodes a picture loaded here at its full size unless given one
  // (`ImageLoadTask` asks Glide for `SIZE_ORIGINAL`), only to let it go.
  it('decodes a picture at about the tile size on Android, and as it was on iOS', async () => {
    const tile = { width: 129.6, height: 175.1 };
    platform.OS = 'android';
    warmup.warmImages([{ url: 'https://cdn.example.com/a.webp', cacheKey: 'a' }], null, tile);
    await settle();
    await finishNext();
    platform.OS = 'ios';
    warmup.warmImages([{ url: 'https://cdn.example.com/b.webp', cacheKey: 'b' }], null, tile);
    await settle();
    await finishNext();

    expect(loads.options).toEqual([{ maxWidth: 130, maxHeight: 176 }, undefined]);
  });

  it('stops before the next picture once stopped', async () => {
    const stop = warmup.warmImages([
      { url: 'https://cdn.example.com/a.webp', cacheKey: 'a' },
      { url: 'https://cdn.example.com/b.webp', cacheKey: 'b' },
    ], null);
    await settle();
    stop();
    await finishNext();

    expect(loads.calls.map((call) => call.cacheKey)).toEqual(['a']);
    // Stopped pictures can be asked for again by a later warm-up.
    warmup.warmImages([{ url: 'https://cdn.example.com/b.webp', cacheKey: 'b' }], null);
    await settle();
    expect(loads.calls.map((call) => call.cacheKey)).toEqual(['a', 'b']);
  });
});

describe('mediaSourceFor', () => {
  const signedUrl = (expiresAtMs: number) => {
    const token = `head.${Buffer.from(JSON.stringify({ exp: expiresAtMs / 1000 })).toString('base64url')}.signature`;
    return `https://project.supabase.co/storage/v1/object/sign/generated_images/owner/preview.webp?token=${token}`;
  };

  // A warm-up under any other source fills a cache entry no tile reads.
  it.each([
    ['a public link', () => 'https://cdn.example.com/image.webp'],
    ['the media proxy', () => 'https://magicbooklet.com/api/media?bucket=generated_images&path=owner%2Fpreview.webp'],
    ['a signed link well before it expires', () => signedUrl(1_000_000_000)],
    ['a signed link about to expire', () => signedUrl(1_000_010)],
  ])('builds the source a tile builds for %s', (_name, link) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const url = link();
    let fromHook: ReturnType<typeof useMediaSource> | null = null;
    function Probe() {
      fromHook = useMediaSource(url);
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Probe />); });

    expect(warmup.mediaSourceFor(url, auth.session.access_token, Date.now())).toEqual(fromHook!.source);
    renderer.act(() => tree.unmount());
  });
});
