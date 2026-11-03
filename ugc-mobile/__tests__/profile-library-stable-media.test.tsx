(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ isGuest: false, identityUserId: 'user-1' }),
}));

// The project's Storage, which the signed addresses below are on.
vi.mock('../lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/env')>();
  return { ...actual, env: { ...actual.env, supabaseUrl: 'https://project.supabase.co' } };
});

import { buildImmersiveGenerationItems } from '../lib/immersive-preview-view-model';
import { refreshProfileLibraryHead } from '../lib/profile-library-head';
import { keepLibraryMediaAddresses, preserveStableLibraryMedia } from '../lib/profile-library-stable-media';
import { getShowcaseMediaPreviewUrl } from '../lib/showcase-media';
import type { GenerationListItem, GenerationListResponse, OwnerPostsResponse } from '../lib/types';
import { useProfileLibrarySource } from '../lib/use-profile-library-source';

const STORAGE = 'https://project.supabase.co';
const MINUTE_MS = 60_000;

type LibraryProps = Parameters<typeof useProfileLibrarySource>[0];
type LibraryResult = ReturnType<typeof useProfileLibrarySource>;

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** An address signed the way the owner list signs one: for an hour from `signedAtMs`. */
function signedUrl(path: string, signedAtMs: number, lifetimeMs = 60 * MINUTE_MS): string {
  const token = [
    base64Url({ alg: 'HS256', typ: 'JWT' }),
    base64Url({ url: path, iat: Math.floor(signedAtMs / 1000), exp: Math.floor((signedAtMs + lifetimeMs) / 1000) }),
    `signature-${signedAtMs}`,
  ].join('.');
  return `${STORAGE}/storage/v1/object/sign/${path}?token=${token}`;
}

/**
 * A finished image creation as one read of the owner list returns it: its
 * original, preview and display rendition each signed at `signedAtMs`.
 */
function creation(id: string, signedAtMs: number, previewPath = `user-1/previews/${id}.webp`): GenerationListItem {
  const original = signedUrl(`generated_images/user-1/${id}.png`, signedAtMs);
  const preview = signedUrl(`generated_images/${previewPath}`, signedAtMs);
  return {
    id,
    output_url: original,
    preview_url: preview,
    status: 'succeeded',
    created_at: '2026-11-03T10:00:00.000Z',
    model: 'nano-banana-2',
    category: 'image',
    title: id,
    media: {
      id,
      kind: 'image',
      url: original,
      renditionUrl: null,
      teaserUrl: null,
      feedStreamUrl: null,
      displayUrl: signedUrl(`generated_images/user-1/display/${id}.webp`, signedAtMs),
      previewUrl: preview,
      thumbhash: 'thumbhash',
      cacheKey: previewPath,
      expiresAt: new Date(signedAtMs + 55 * MINUTE_MS).toISOString(),
      width: 720,
      height: 960,
      durationSeconds: null,
      status: 'ready',
      gridReady: true,
    },
  };
}

function generationPage(items: GenerationListItem[]): GenerationListResponse {
  return { generations: items, pagination: { limit: 24, hasMore: false, nextCursor: null } };
}

function stubApi(reads: GenerationListResponse[]) {
  const listGenerations = vi.fn();
  for (const read of reads) listGenerations.mockResolvedValueOnce(read);
  return {
    listGenerations,
    listOwnerPosts: vi.fn(async () => ({ success: true, posts: [], pageInfo: { hasMore: false, nextOffset: null } }) as unknown as OwnerPostsResponse),
    getOwnerPost: vi.fn(),
    getSavedMedia: vi.fn(),
  };
}

const owner = { creatorLabel: '@owner', creatorAvatar: null, creatorId: 'user-1' };

/** The library the card feed reads, as `ProfileMediaFeedScreen` mounts it on a tapped creation. */
async function renderCardFeedLibrary(api: ReturnType<typeof stubApi>, initialId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const latest: { current: LibraryResult | null } = { current: null };

  function Probe() {
    latest.current = useProfileLibrarySource({
      api: api as unknown as LibraryProps['api'],
      userId: 'user-1',
      source: 'profile-creations',
      initialId,
      owner,
    });
    return null;
  }

  await renderer.act(async () => {
    renderer.create(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  });

  /** React Query tells its observers on a later tick. */
  async function settle() {
    for (let tick = 0; tick < 3; tick += 1) {
      await renderer.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    return latest.current!;
  }

  return {
    client,
    latest,
    settle,
    async until(predicate: (result: LibraryResult) => boolean) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (latest.current && predicate(latest.current)) return latest.current;
        await renderer.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      throw new Error('The library never reached the expected state.');
    },
    /** The card feed's revalidation: the first page read again and merged. */
    async refreshHead() {
      const before = client.getQueryState(['profile-generations', 'user-1'])?.dataUpdateCount ?? 0;
      await renderer.act(async () => {
        await refreshProfileLibraryHead({ api: api as never, queryClient: client, userId: 'user-1', library: 'Creations' });
      });
      const refreshed = await settle();
      // The read landed in the library, whatever it changed there.
      expect(client.getQueryState(['profile-generations', 'user-1'])?.dataUpdateCount).toBe(before + 1);
      return refreshed;
    },
  };
}

/** The address the card's picture is drawn from (`ShowcaseMediaSlide`'s preview). */
function drawnAddress(result: LibraryResult, id: string) {
  const item = result.items.find((candidate) => candidate.id === id);
  return item ? getShowcaseMediaPreviewUrl(item.mediaItems[0]) : null;
}

describe('the card feed’s pictures when its library’s first page is read again', () => {
  // Pixel 9a emulator, 2026-11-03: the card a Creations tile opened was sharp,
  // went blank about 1.3 s later with nothing touched, showed its thumbhash and
  // was sharp again 0.1 s after that. Every read of the owner list signs each
  // file again, and a picture is drawn from its address: a new address for the
  // same file starts the picture over.
  it('keeps drawing a creation from the address it already has when the read only signs it again', async () => {
    const firstReadAt = Date.now();
    const api = stubApi([
      generationPage([creation('tapped', firstReadAt), creation('older', firstReadAt)]),
      generationPage([creation('tapped', firstReadAt + 70_000), creation('older', firstReadAt + 70_000)]),
    ]);
    const library = await renderCardFeedLibrary(api, 'tapped');
    const landed = await library.until((result) => result.selection === 'found');
    const drawn = drawnAddress(landed, 'tapped');

    const refreshed = await library.refreshHead();

    expect(api.listGenerations).toHaveBeenCalledTimes(2);
    expect(drawn).toBeTruthy();
    expect(drawnAddress(refreshed, 'tapped')).toBe(drawn);
    // Nothing to draw again: the cards are the ones already on screen.
    expect(refreshed.items).toBe(landed.items);
  });

  it('keeps the addresses of a creation looked up on its own when the lookup is read again', async () => {
    const firstReadAt = Date.now();
    const api = stubApi([
      generationPage([creation('recent', firstReadAt)]),
      { generations: [creation('older', firstReadAt)] },
      { generations: [creation('older', firstReadAt + 70_000)] },
    ]);
    const library = await renderCardFeedLibrary(api, 'older');
    const landed = await library.until((result) => result.selection === 'found');
    const drawn = drawnAddress(landed, 'older');

    await renderer.act(async () => {
      await library.latest.current!.retrySelection();
    });
    const refreshed = await library.settle();

    expect(api.listGenerations).toHaveBeenLastCalledWith(true, { id: 'older', limit: 1 });
    expect(library.client.getQueryState(['profile-library-selection', 'profile-creations', 'user-1', 'older'])?.dataUpdateCount).toBe(2);
    expect(drawn).toBeTruthy();
    expect(drawnAddress(refreshed, 'older')).toBe(drawn);
  });

  it('draws a creation whose preview is a new file from the new file', async () => {
    const firstReadAt = Date.now();
    const api = stubApi([
      generationPage([creation('tapped', firstReadAt)]),
      generationPage([creation('tapped', firstReadAt + 70_000, 'user-1/previews/tapped-v2.webp')]),
    ]);
    const library = await renderCardFeedLibrary(api, 'tapped');
    await library.until((result) => result.selection === 'found');

    const refreshed = await library.refreshHead();

    expect(drawnAddress(refreshed, 'tapped')).toBe(signedUrl('generated_images/user-1/previews/tapped-v2.webp', firstReadAt + 70_000));
    expect(refreshed.items[0].mediaItems[0].previewCacheKey).toBe('user-1/previews/tapped-v2.webp');
  });

  it('takes the new address once the one it has is within five minutes of its end', async () => {
    const now = Date.now();
    const signedLongAgo = now - 56 * MINUTE_MS;
    const api = stubApi([
      generationPage([creation('tapped', signedLongAgo)]),
      generationPage([creation('tapped', now)]),
    ]);
    const library = await renderCardFeedLibrary(api, 'tapped');
    await library.until((result) => result.selection === 'found');

    const refreshed = await library.refreshHead();

    expect(drawnAddress(refreshed, 'tapped')).toBe(signedUrl('generated_images/user-1/previews/tapped.webp', now));
  });
});

/** A Creations library's loaded pages, each but the last continuing through a cursor. */
function loadedLibrary(...pages: GenerationListItem[][]) {
  return {
    pages: pages.map((items, index) => ({
      generations: items,
      pagination: {
        limit: 24,
        hasMore: index < pages.length - 1,
        nextCursor: index < pages.length - 1 ? `cursor-${index + 1}` : null,
      },
    })),
    pageParams: pages.map((_, index) => (index === 0 ? null : `cursor-${index}`)),
  };
}

describe('a library read again, against the addresses it held', () => {
  const NOW = Date.parse('2026-11-03T10:00:00.000Z');
  // Held addresses signed ten minutes before the read, with fifty to live.
  const HELD = NOW - 10 * MINUTE_MS;

  it('keeps every address of a creation the read only signed again, wherever the creation now sits', () => {
    // `a` was deleted, so `c` rose from the second page to the first.
    const previous = loadedLibrary([creation('a', HELD), creation('b', HELD)], [creation('c', HELD)]);
    const next = loadedLibrary([creation('b', NOW), creation('c', NOW)], []);

    const kept = preserveStableLibraryMedia(previous, next, NOW, STORAGE);

    expect(kept.pages[0].generations).toEqual([creation('b', HELD), creation('c', HELD)]);
    expect(kept.pages[1].generations).toEqual([]);
    expect(kept.pageParams).toBe(next.pageParams);
  });

  it('takes a creation it did not hold, and a file that is new, as the read has them', () => {
    const previous = loadedLibrary([creation('a', HELD)]);
    const next = loadedLibrary([creation('fresh', NOW), creation('a', NOW, 'user-1/previews/a-v2.webp')]);

    const kept = preserveStableLibraryMedia(previous, next, NOW, STORAGE);
    const [fresh, a] = kept.pages[0].generations;

    expect(fresh).toBe(next.pages[0].generations[0]);
    // The preview is a new file; the original and the display rendition are not.
    expect(a.preview_url).toBe(signedUrl('generated_images/user-1/previews/a-v2.webp', NOW));
    expect(a.media?.previewUrl).toBe(signedUrl('generated_images/user-1/previews/a-v2.webp', NOW));
    expect(a.media?.cacheKey).toBe('user-1/previews/a-v2.webp');
    expect(a.output_url).toBe(creation('a', HELD).output_url);
    expect(a.media?.url).toBe(creation('a', HELD).media?.url);
    expect(a.media?.displayUrl).toBe(creation('a', HELD).media?.displayUrl);
    // Dated by the earliest of its addresses: the ones kept from the read before.
    expect(a.media?.expiresAt).toBe(creation('a', HELD).media?.expiresAt);
  });

  it('keeps a held address with more than five minutes to live, and gives one with less way to the read', () => {
    const almostFiveMinutesLeft = NOW - 55 * MINUTE_MS - 30_000;
    const overFiveMinutesLeft = NOW - 54 * MINUTE_MS - 30_000;

    const ending = preserveStableLibraryMedia(loadedLibrary([creation('a', almostFiveMinutesLeft)]), loadedLibrary([creation('a', NOW)]), NOW, STORAGE);
    const living = preserveStableLibraryMedia(loadedLibrary([creation('a', overFiveMinutesLeft)]), loadedLibrary([creation('a', NOW)]), NOW, STORAGE);

    expect(ending.pages[0].generations[0]).toEqual(creation('a', NOW));
    expect(living.pages[0].generations[0]).toEqual(creation('a', overFiveMinutesLeft));
  });

  it('leaves every address it cannot date, and every other value, as the read has it', () => {
    const elsewhere = (signedAt: number) => signedUrl('generated_images/user-1/a.png', signedAt).replace(STORAGE, 'https://elsewhere.test');
    const previous = { pages: [{ items: [{
      id: 'post-1',
      url: `${STORAGE}/storage/v1/object/public/showcase_media/post-1.webp?v=1`,
      proxied: 'https://magicbooklet.com/api/media?bucket=generated_videos&path=user-1%2Fa.mp4',
      elsewhere: elsewhere(HELD),
      title: 'Before',
    }] }] };
    const next = { pages: [{ items: [{
      id: 'post-1',
      url: `${STORAGE}/storage/v1/object/public/showcase_media/post-1.webp?v=2`,
      proxied: 'https://magicbooklet.com/api/media?bucket=generated_videos&path=user-1%2Fb.mp4',
      elsewhere: elsewhere(NOW),
      title: 'After',
    }] }] };

    expect(preserveStableLibraryMedia(previous, next, NOW, STORAGE)).toBe(next);
  });

  it('exchanges an address only for one that differs from it in nothing but its signature', () => {
    const held = signedUrl('generated_images/user-1/a.png', HELD);
    const resigned = signedUrl('generated_images/user-1/a.png', NOW);
    const previous = { id: 'a', download: held, prompt: `${held} make it blue` };
    const next = { id: 'a', download: `${resigned}&download=a.png`, prompt: `${resigned} make it red` };

    expect(preserveStableLibraryMedia(previous, next, NOW, STORAGE)).toBe(next);
    // And with nothing to date addresses by, nothing is kept.
    expect(preserveStableLibraryMedia({ id: 'a', url: held }, { id: 'a', url: resigned }, NOW, '')).toEqual({ id: 'a', url: resigned });
  });

  it('keeps a run’s outputs by position, so its descriptor still belongs to its first one', () => {
    const run = (signedAt: number): GenerationListItem => {
      const single = creation('run', signedAt);
      const first = single.output_url!;
      return { ...single, output_urls: [first, signedUrl('generated_images/user-1/run-2.png', signedAt)] };
    };

    const kept = preserveStableLibraryMedia(loadedLibrary([run(HELD)]), loadedLibrary([run(NOW)]), NOW, STORAGE);
    const [slide] = buildImmersiveGenerationItems('profile-creations', kept.pages[0].generations, owner)[0].mediaItems;

    expect(kept.pages[0].generations[0]).toEqual(run(HELD));
    expect(slide.url).toBe(run(HELD).output_urls![0]);
    expect(slide.previewCacheKey).toBe('user-1/previews/run.webp');
  });
});

describe('the libraries’ structural sharing', () => {
  it('hands back the data the library had when a read only signed its files again', () => {
    const now = Date.now();
    const previous = loadedLibrary([creation('a', now - 10 * MINUTE_MS), creation('b', now - 10 * MINUTE_MS)]);

    expect(keepLibraryMediaAddresses(previous, loadedLibrary([creation('a', now), creation('b', now)]))).toBe(previous);
  });

  it('shares what did not change and keeps the addresses of what did', () => {
    const now = Date.now();
    const held = now - 10 * MINUTE_MS;
    const previous = loadedLibrary([creation('a', held), creation('b', held)]);
    const next = loadedLibrary([creation('a', now), { ...creation('b', now), title: 'Renamed' }]);

    const shared = keepLibraryMediaAddresses(previous, next) as typeof previous;

    expect(shared).not.toBe(previous);
    expect(shared.pages[0].generations[0]).toBe(previous.pages[0].generations[0]);
    expect(shared.pages[0].generations[1]).toEqual({ ...creation('b', held), title: 'Renamed' });
  });

  it('takes a first read whole', () => {
    const first = loadedLibrary([creation('a', Date.now())]);

    expect(keepLibraryMediaAddresses(undefined, first)).toBe(first);
  });
});
