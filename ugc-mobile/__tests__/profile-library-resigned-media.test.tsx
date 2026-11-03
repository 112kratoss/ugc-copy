(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

// The project's Storage, which the signed addresses below are on.
vi.mock('@/lib/env', () => ({
  env: { apiBaseUrl: 'https://magicbooklet.com', supabaseUrl: 'https://project.supabase.co', siteUrl: 'https://magicbooklet.com' },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ session: null, isGuest: false, identityUserId: 'user-1' }) }));
vi.mock('@/components/recoverable-video-preview', () => ({
  RecoverableVideoPreview: (props: MockProps) => React.createElement('video-preview', props),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));
vi.mock('lucide-react-native', () => ({
  ImageOff: (props: MockProps) => React.createElement('image-off', props),
  Play: (props: MockProps) => React.createElement('play', props),
}));

import { StableMediaImage } from '../components/media-preview';
import { buildImmersiveGenerationItems } from '../lib/immersive-preview-view-model';
import { refreshProfileLibraryHead } from '../lib/profile-library-head';
import { flattenProfileGenerationPages, profileGenerationsQueryOptions } from '../lib/profile-media-query';
import { generationToProfileMediaCard } from '../lib/profile-view-model';
import type { GenerationListItem, GenerationListResponse } from '../lib/types';

const STORAGE = 'https://project.supabase.co';
const MINUTE_MS = 60_000;
const T0 = Date.parse('2026-11-03T10:00:00.000Z');
const LIBRARY_KEY = ['profile-generations', 'user-1'];

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** An address signed the way the owner list signs one: for an hour from `signedAtMs`. */
function signedUrl(path: string, signedAtMs: number): string {
  const token = [
    base64Url({ alg: 'HS256', typ: 'JWT' }),
    base64Url({ url: path, iat: Math.floor(signedAtMs / 1000), exp: Math.floor((signedAtMs + 60 * MINUTE_MS) / 1000) }),
    `signature-${signedAtMs}`,
  ].join('.');
  return `${STORAGE}/storage/v1/object/sign/${path}?token=${token}`;
}

/** A finished image creation as one read of the owner list returns it, every file signed at `signedAtMs`. */
function creation(id: string, signedAtMs: number): GenerationListItem {
  const original = signedUrl(`generated_images/user-1/${id}.png`, signedAtMs);
  const preview = signedUrl(`generated_images/user-1/previews/${id}.webp`, signedAtMs);
  return {
    id,
    output_url: original,
    preview_url: preview,
    status: 'succeeded',
    created_at: '2026-11-03T09:00:00.000Z',
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
      cacheKey: `user-1/previews/${id}.webp`,
      expiresAt: new Date(signedAtMs + 55 * MINUTE_MS).toISOString(),
      width: 720,
      height: 960,
      durationSeconds: null,
      status: 'ready',
      gridReady: true,
    },
  };
}

/** One read of the library's first page, its files signed at `signedAtMs`. */
function read(signedAtMs: number): GenerationListResponse {
  return {
    generations: [creation('tapped', signedAtMs), creation('older', signedAtMs)],
    pagination: { limit: 24, hasMore: false, nextCursor: null },
  };
}

/**
 * The Creations library as Profile and its card feed share it: the query the
 * grid pages, filled by its first read, and read again as the grid and the
 * card feed read it again (on focus, on return to the app, every 15 s while a
 * run renders), through `refreshProfileLibraryHead`.
 */
async function library(...reads: GenerationListResponse[]) {
  const listGenerations = vi.fn();
  for (const response of reads) listGenerations.mockResolvedValueOnce(response);
  const api = { listGenerations, listOwnerPosts: vi.fn(), getSavedMedia: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.fetchInfiniteQuery(profileGenerationsQueryOptions(api as never, 'user-1'));
  const items = () => flattenProfileGenerationPages(
    client.getQueryData<{ pages: GenerationListResponse[] }>(LIBRARY_KEY)?.pages,
  );
  return {
    items,
    /** What a Creations tile draws: the card's preview under its cache key. */
    tile(id: string) {
      const card = generationToProfileMediaCard(items().find((item) => item.id === id)!);
      return <StableMediaImage url={card.previewUrl!} cacheKey={card.previewCacheKey ?? card.id} thumbhash={card.previewThumbhash} />;
    },
    async readAgain() {
      await refreshProfileLibraryHead({ api: api as never, queryClient: client, userId: 'user-1', library: 'Creations' });
    },
  };
}

/** The native image the session draws: one with a source, not the failure plate's thumbhash. */
function picture(tree: renderer.ReactTestRenderer) {
  const drawn = tree.root.findAll((node) => node.type === 'image' && Boolean(node.props.source));
  return drawn.length === 1 ? drawn[0] : null;
}

function mount(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => { tree = renderer.create(element); });
  return tree;
}

/** Fails the image drawn from `address` until its retries are spent and it shows the plate. */
function failWhileDrawing(tree: renderer.ReactTestRenderer, address: string) {
  for (let guard = 0; guard < 25; guard += 1) {
    const image = picture(tree);
    if (!image || image.props.source.uri !== address) return;
    renderer.act(() => (image.props.onError as () => void)());
    renderer.act(() => { vi.advanceTimersByTime(5_000); });
  }
  throw new Error('the image never gave up on the address');
}

describe('a Creations tile when its library is read again', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Every read of the owner list signs each file anew. Keyed on the whole
  // address, each read started every picture over, blank, then thumbhash,
  // then picture (a Creations card on the Pixel 9a emulator, 2026-11-03).
  it('keeps drawing the picture it has, in the same native image, through a read that signs it again', async () => {
    const creations = await library(read(T0), read(T0 + MINUTE_MS));
    const tree = mount(creations.tile('tapped'));
    const before = picture(tree)!;
    renderer.act(() => (before.props.onDisplay as () => void)());

    vi.setSystemTime(T0 + MINUTE_MS);
    await creations.readAgain();
    const resigned = creations.tile('tapped');
    renderer.act(() => { tree.update(resigned); });

    // The read hands the tile the file's new signature; the tile keeps the one it draws.
    expect(resigned.props.url).toBe(creation('tapped', T0 + MINUTE_MS).preview_url);
    const after = picture(tree)!;
    expect(after).toBe(before);
    expect(after.props.source).toEqual({ uri: creation('tapped', T0).preview_url, cacheKey: 'user-1/previews/tapped.webp' });
    expect(JSON.stringify(tree.toJSON())).not.toContain('Preview unavailable');
  });

  // Review of #679, finding 1: the library kept the address it held, so a read
  // handed a tile that had given up the very address it gave up on.
  it('tries the newer signature a read brings once it has given up on the one it had', async () => {
    const creations = await library(read(T0), read(T0 + MINUTE_MS));
    const tree = mount(creations.tile('tapped'));
    failWhileDrawing(tree, creation('tapped', T0).preview_url!);
    expect(picture(tree)).toBeNull();
    expect(JSON.stringify(tree.toJSON())).toContain('Preview unavailable');

    vi.setSystemTime(T0 + MINUTE_MS);
    await creations.readAgain();
    renderer.act(() => { tree.update(creations.tile('tapped')); });

    expect(picture(tree)!.props.source.uri).toBe(creation('tapped', T0 + MINUTE_MS).preview_url);
    expect(JSON.stringify(tree.toJSON())).not.toContain('Preview unavailable');
  });
});

describe('the addresses a library read again holds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Review of #679, finding 2: a read fifty minutes in kept the first read's
  // addresses, which ended ten minutes later. Download opens the address it is
  // handed (`Linking.openURL`), and the audio player plays it, as they are.
  it('are the newest read’s, for Download and the audio player as for every picture', async () => {
    const creations = await library(read(T0), read(T0 + 50 * MINUTE_MS));
    vi.setSystemTime(T0 + 50 * MINUTE_MS);

    await creations.readAgain();

    const [tapped] = creations.items();
    expect(tapped.output_url).toBe(creation('tapped', T0 + 50 * MINUTE_MS).output_url);
    expect(tapped.media?.previewUrl).toBe(creation('tapped', T0 + 50 * MINUTE_MS).preview_url);
    // The card feed's and the reel's item: what Download opens.
    const [card] = buildImmersiveGenerationItems('profile-creations', creations.items(), { creatorLabel: '@owner', creatorAvatar: null });
    expect(card.mediaItems[0].url).toBe(creation('tapped', T0 + 50 * MINUTE_MS).output_url);
  });
});
