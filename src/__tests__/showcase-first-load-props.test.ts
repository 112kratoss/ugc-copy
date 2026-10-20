import { describe, expect, expectTypeOf, it } from 'vitest';

import { buildVisualMediaDescriptor } from '@/lib/media-descriptor';
import type { PostMediaSummary } from '@/lib/post-media';
import {
  SHOWCASE_APP_ONLY_MEDIA_FIELDS,
  toShowcaseBootstrapFeedPage,
  type ShowcaseFeedItem,
  type ShowcaseFeedPage,
  type ShowcaseMediaItem,
} from '@/lib/showcase';
import { FALLBACK_SOURCE_TOOLS, toSourceToolFilterOptions } from '@/lib/source-tools';

// A media row as post-media.ts serves it to every surface, the app's fields included.
function createMediaRow(overrides: Partial<PostMediaSummary> = {}): PostMediaSummary {
  const preview = buildVisualMediaDescriptor({
    id: 'media-1',
    kind: 'video',
    url: 'https://example.com/source.mp4',
    storageKey: 'showcase/post/source.mp4',
    renditionUrl: 'https://example.com/source.feed.mp4',
    teaserUrl: null,
    feedStreamUrl: 'https://example.com/source.feed.mp4',
    previewUrl: 'https://example.com/source.preview.0123456789abcdef.webp',
    previewStorageKey: 'showcase/post/source.preview.0123456789abcdef.webp',
    previewThumbhash: 'SRgKDAIpuCgGp3RbZ2c4mICDCQ==',
    previewStatus: 'ready',
    expiresAt: null,
    width: 720,
    height: 1280,
    durationSeconds: 6.03,
  });
  return {
    id: 'media-1',
    mediaKey: 'media-1',
    url: preview.url,
    displayUrl: null,
    renditionUrl: preview.renditionUrl,
    renditionStatus: 'ready',
    teaserUrl: preview.teaserUrl,
    feedStreamUrl: preview.feedStreamUrl,
    previewUrl: preview.previewUrl,
    previewThumbhash: preview.thumbhash,
    previewStatus: 'ready',
    previewCacheKey: preview.cacheKey,
    gridReady: preview.gridReady,
    preview,
    mediaKind: 'video',
    contentType: 'video/mp4',
    originalName: 'source.mp4',
    width: 720,
    height: 1280,
    durationSeconds: 6.03,
    sortOrder: 0,
    ...overrides,
  };
}

function createItem(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://example.com/source.mp4',
    mediaKind: 'video',
    mediaItems: [createMediaRow(), createMediaRow({ id: 'media-2', mediaKey: 'media-2', sortOrder: 1 })],
    model: 'kling-3.0',
    title: 'Paper boat',
    prompt: 'A paper boat drifting across a pond',
    body: '',
    category: 'video',
    postFormat: 'media',
    saveCount: 2,
    remixCount: 0,
    commentCount: 1,
    createdAt: '2026-10-20T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
    sourceKind: 'magicbooklet',
    sourceTool: 'magicbooklet',
    generationId: 'generation-1',
    asset: null,
    canRemix: true,
    ...overrides,
  };
}

describe('what Explore and the marketplace write into a first load', () => {
  it('hands the tool filters only the slug and label each chip uses', () => {
    const options = toSourceToolFilterOptions(FALLBACK_SOURCE_TOOLS);

    expect(options).toEqual(FALLBACK_SOURCE_TOOLS.map((tool) => ({ slug: tool.slug, label: tool.label })));
    expect(options.every((option) => Object.keys(option).join(',') === 'slug,label')).toBe(true);
  });

  it('leaves out the media fields only the app reads and keeps every other one', () => {
    const textPost = createItem({
      id: 'post-2',
      mediaUrl: null,
      mediaKind: null,
      mediaItems: undefined,
      category: 'text',
      postFormat: 'text',
    });
    const feed: ShowcaseFeedPage = {
      items: [createItem(), textPost],
      pageInfo: { hasMore: true, nextOffset: 12, limit: 12, offset: 0 },
      feedSessionId: 'session-1',
      algorithmVersion: 'v4',
    };
    const before = structuredClone(feed);

    const trimmed = toShowcaseBootstrapFeedPage(feed);

    expect(feed).toEqual(before);
    const appOnly = new Set<string>(SHOWCASE_APP_ONLY_MEDIA_FIELDS);
    const keptMediaItems = before.items[0].mediaItems?.map((mediaItem) => Object.fromEntries(
      Object.entries(mediaItem).filter(([field]) => !appOnly.has(field)),
    ));
    expect(trimmed).toEqual({
      ...before,
      items: [{ ...before.items[0], mediaItems: keptMediaItems }, textPost],
    });
    for (const mediaItem of trimmed.items[0].mediaItems ?? []) {
      for (const field of SHOWCASE_APP_ONLY_MEDIA_FIELDS) expect(mediaItem).not.toHaveProperty(field);
    }
  });

  it('keeps the app-only media fields off the web’s media type', () => {
    // A server media field is either on ShowcaseMediaItem, where the web may read
    // it and the first page keeps it, or on this list, where the web cannot read
    // it (a typecheck error) and the first page drops it. A new field has to
    // take one side before typecheck:tests passes again.
    expectTypeOf<Exclude<keyof PostMediaSummary, keyof ShowcaseMediaItem>>()
      .toEqualTypeOf<(typeof SHOWCASE_APP_ONLY_MEDIA_FIELDS)[number]>();
  });
});
