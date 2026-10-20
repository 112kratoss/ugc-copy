import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildVisualMediaDescriptor } from '@/lib/media-descriptor';
import {
  toShowcaseBootstrapFeedPage,
  type ShowcaseFeedItem,
  type ShowcaseFeedPage,
  type ShowcaseMediaItem,
} from '@/lib/showcase';
import { FALLBACK_SOURCE_TOOLS, toSourceToolFilterOptions } from '@/lib/source-tools';

const SRC_ROOT = path.join(process.cwd(), 'src');

function createMediaItem(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
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
    renditionUrl: preview.renditionUrl,
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
    mediaItems: [createMediaItem(), createMediaItem({ id: 'media-2', mediaKey: 'media-2', sortOrder: 1 })],
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

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'api' ? [] : listSourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
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
    const keptMediaItems = before.items[0].mediaItems?.map((mediaItem) => {
      const kept = { ...mediaItem };
      delete kept.preview;
      delete kept.previewCacheKey;
      return kept;
    });
    expect(trimmed).toEqual({
      ...before,
      items: [{ ...before.items[0], mediaItems: keptMediaItems }, textPost],
    });
    for (const mediaItem of trimmed.items[0].mediaItems ?? []) {
      expect(mediaItem).not.toHaveProperty('preview');
      expect(mediaItem).not.toHaveProperty('previewCacheKey');
    }
  });

  it('pairs every web read of a media preview with the item’s own field', () => {
    // The first load's media items carry no `preview` (toShowcaseBootstrapFeedPage),
    // so a web read of one with nothing to fall back on would draw those posts
    // differently from the ones a later page brings.
    const previewReads = [path.join(SRC_ROOT, 'app'), path.join(SRC_ROOT, 'components')]
      .flatMap(listSourceFiles)
      .flatMap((file) => readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /\.preview\??\.(?:url|renditionUrl|teaserUrl|feedStreamUrl|previewUrl|thumbhash|cacheKey|width|height|durationSeconds|status|gridReady)\b/.test(line))
        .map((line) => `${path.relative(SRC_ROOT, file)}: ${line.trim()}`));

    expect(previewReads.length).toBeGreaterThan(0);
    expect(previewReads.filter((read) => !read.includes('??'))).toEqual([]);
  });
});
