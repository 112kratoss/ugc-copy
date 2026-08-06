import { describe, expect, it } from 'vitest';

import { generationToProfileMediaCard, getProfileStats, ownerPostToProfileMediaCard } from '../lib/profile-view-model';
import type { GenerationListItem, OwnerPostListItem } from '../lib/types';

describe('profile view model media cards', () => {
  it('maps generation previewUrl so video creation tiles can render persisted posters', () => {
    const item: GenerationListItem = {
      id: 'gen-video-1',
      output_url: 'https://cdn.example.com/video.mp4',
      preview_url: 'https://cdn.example.com/video-poster.webp',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'kling-3.0-video',
      category: 'video',
      media: {
        id: 'gen-video-1',
        kind: 'video',
        url: 'https://cdn.example.com/video.mp4',
        previewUrl: 'https://cdn.example.com/video-poster.webp',
        thumbhash: 'video-thumbhash',
        cacheKey: 'generated_videos/video.preview.hash.webp',
        expiresAt: '2026-06-10T11:00:00.000Z',
        width: null,
        height: null,
        durationSeconds: 5,
        status: 'ready',
        gridReady: true,
      },
      title: 'Street motion',
      prompt: 'A creator walks through a market.',
    };

    expect(generationToProfileMediaCard(item)).toMatchObject({
      mediaKind: 'video',
      previewUrl: 'https://cdn.example.com/video-poster.webp',
      previewState: 'videoPoster',
      isGridReady: true,
      previewThumbhash: 'video-thumbhash',
      previewCacheKey: 'generated_videos/video.preview.hash.webp',
    });
  });

  it('maps ugc-ad generations as video media cards', () => {
    const item: GenerationListItem = {
      id: 'gen-ugc-ad-1',
      output_url: 'https://cdn.example.com/ugc-ad.mp4',
      preview_url: 'https://cdn.example.com/ugc-ad-poster.webp',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'ugc-ad-model',
      category: 'ugc-ad',
      title: 'UGC ad',
      prompt: 'A creator ad spot.',
    };

    expect(generationToProfileMediaCard(item)).toMatchObject({
      mediaKind: 'video',
      previewState: 'videoPoster',
      isGridReady: true,
    });
  });

  it('keeps image generations without a completed derivative out of the grid', () => {
    const item: GenerationListItem = {
      id: 'gen-image-1',
      output_url: 'https://cdn.example.com/image.jpg',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'nano-banana-2',
      category: 'image',
      title: 'Image still',
      prompt: 'A product still.',
    };

    expect(generationToProfileMediaCard(item)).toMatchObject({
      previewUrl: 'https://cdn.example.com/image.jpg',
      previewState: 'image',
      isGridReady: false,
    });
  });

  it('does not use the video file as a preview when a poster is missing', () => {
    const item: GenerationListItem = {
      id: 'gen-video-missing-poster',
      output_url: 'https://cdn.example.com/video.mp4',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'kling-3.0-video',
      category: 'video',
      title: 'Video only',
      prompt: 'A video generation.',
    };

    expect(generationToProfileMediaCard(item)).toMatchObject({
      previewUrl: null,
      previewState: 'videoFallback',
      previewStatusLabel: 'Preview unavailable',
      isGridReady: false,
    });
  });

  it('marks failed, processing, archived, and missing-media generations as not grid-ready', () => {
    const base: GenerationListItem = {
      id: 'gen-base',
      output_url: 'https://cdn.example.com/image.jpg',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'nano-banana-2',
      category: 'image',
      title: 'Image still',
      prompt: 'A product still.',
    };

    expect(generationToProfileMediaCard({ ...base, id: 'failed', status: 'failed' }).isGridReady).toBe(false);
    expect(generationToProfileMediaCard({ ...base, id: 'processing', status: 'processing' }).isGridReady).toBe(false);
    expect(generationToProfileMediaCard({ ...base, id: 'archived', archived_at: '2026-06-11T00:00:00.000Z' }).isGridReady).toBe(false);
    expect(generationToProfileMediaCard({ ...base, id: 'missing', output_url: null }).isGridReady).toBe(false);
  });

  it('marks owner posts without usable preview content as not grid-ready', () => {
    const base: OwnerPostListItem = {
      id: 'post-base',
      title: 'Manual post',
      createdAt: '2026-06-10T10:00:00.000Z',
      visibility: 'public',
      mediaUrl: null,
      mediaKind: null,
      commentCount: 0,
      body: '',
      prompt: '',
      description: '',
      category: 'image',
      postFormat: 'media',
      bundle: null,
    };

    // An image carried on `posts.output_url` is grid-ready even with no
    // post_media descriptor. Publishing a generation produces exactly that shape
    // -- output_url set, zero post_media rows, so no preview is ever generated --
    // and requiring a descriptor here hid those posts from the mobile grid
    // permanently while the web profile still listed them. This matches the
    // showcase path, which treats a bare image mediaUrl as gridReady.
    expect(ownerPostToProfileMediaCard({
      ...base,
      id: 'image-post',
      mediaUrl: 'https://cdn.example.com/post.jpg',
      mediaKind: 'image',
    })).toMatchObject({
      previewState: 'image',
      isGridReady: true,
    });
    // A video still needs a poster, so a bare mediaUrl is not enough.
    expect(ownerPostToProfileMediaCard({
      ...base,
      id: 'video-post',
      mediaUrl: 'https://cdn.example.com/post.mp4',
      mediaKind: 'video',
    }).isGridReady).toBe(false);
    expect(ownerPostToProfileMediaCard({
      ...base,
      id: 'text-post',
      body: 'A reusable note for framing a beauty product post.',
      category: 'text',
      postFormat: 'text',
    })).toMatchObject({
      previewState: 'text',
      isGridReady: true,
    });
    expect(ownerPostToProfileMediaCard({ ...base, id: 'empty-media-post' }).isGridReady).toBe(false);
    expect(ownerPostToProfileMediaCard({
      ...base,
      id: 'archived-post',
      mediaUrl: 'https://cdn.example.com/post.jpg',
      mediaKind: 'image',
      archivedAt: '2026-06-11T00:00:00.000Z',
    }).isGridReady).toBe(false);
  });
});

describe('profile hero stats', () => {
  it('reports plain counts when every page is loaded', () => {
    expect(getProfileStats({ generationsCount: 3, postsCount: 2, savedCount: 1 })).toEqual([
      { label: 'Creations', value: '3' },
      { label: 'Posts', value: '2' },
      { label: 'Saved', value: '1' },
    ]);
  });

  it('marks a count as partial while that tab has more pages', () => {
    expect(getProfileStats({
      generationsCount: 24,
      generationsHasMore: true,
      postsCount: 2,
      postsHasMore: false,
      savedCount: 48,
      savedHasMore: true,
    })).toEqual([
      { label: 'Creations', value: '24+' },
      { label: 'Posts', value: '2' },
      { label: 'Saved', value: '48+' },
    ]);
  });
});
