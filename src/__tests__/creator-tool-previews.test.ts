import { describe, expect, it, vi } from 'vitest';

import { buildCreatorToolPreviewMap, loadCreatorToolPreviewMap } from '@/lib/creator-tool-previews';

const getShowcaseFeedPageMock = vi.fn();

vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedPage: (...args: unknown[]) => getShowcaseFeedPageMock(...args),
}));

describe('creator tool previews', () => {
  it('builds preview slots directly from available showcase items', () => {
    const previewMap = buildCreatorToolPreviewMap([
      {
        id: 'image-1',
        mediaUrl: 'https://example.com/image.jpg',
        mediaKind: 'image',
        model: 'nano-banana-2',
        title: 'Image',
        prompt: '',
        body: '',
        category: 'image',
        postFormat: 'media',
        saveCount: 0,
        remixCount: 0,
        commentCount: 0,
        createdAt: '2026-04-08T00:00:00.000Z',
        creator: { id: 'creator-1', username: 'creator-1', name: 'Creator 1', avatar: null },
        sourceKind: 'magicbooklet',
        sourceTool: null,
        generationId: 'gen-image-1',
        asset: null,
        canRemix: true,
      },
      {
        id: 'video-1',
        mediaUrl: 'https://example.com/video.mp4',
        mediaKind: 'video',
        model: 'kling-3.0-video',
        title: 'Video',
        prompt: '',
        body: '',
        category: 'video',
        postFormat: 'media',
        saveCount: 0,
        remixCount: 0,
        commentCount: 0,
        createdAt: '2026-04-08T00:00:00.000Z',
        creator: { id: 'creator-2', username: 'creator-2', name: 'Creator 2', avatar: null },
        sourceKind: 'magicbooklet',
        sourceTool: null,
        generationId: 'gen-video-1',
        asset: null,
        canRemix: true,
      },
    ]);

    expect(previewMap.image?.id).toBe('image-1');
    expect(previewMap.video?.id).toBe('video-1');
    expect(previewMap.motion).toBeNull();
    expect(previewMap.workflow).toBeNull();
  });

  it('falls back to category-specific feeds when a tool preview is missing from the seed items', async () => {
    getShowcaseFeedPageMock.mockResolvedValueOnce({
      items: [
        {
          id: 'motion-1',
          mediaUrl: 'https://example.com/motion.mp4',
          mediaKind: 'video',
          model: 'kling-2.6/motion-control',
          title: 'Motion',
          prompt: '',
          body: '',
          category: 'video',
          creationMode: 'motion',
          postFormat: 'media',
          saveCount: 0,
          remixCount: 0,
          commentCount: 0,
          createdAt: '2026-04-08T00:00:00.000Z',
          creator: { id: 'creator-3', username: 'creator-3', name: 'Creator 3', avatar: null },
          sourceKind: 'magicbooklet',
          sourceTool: null,
          generationId: 'gen-motion-1',
          asset: null,
          canRemix: true,
        },
      ],
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        limit: 1,
        offset: 0,
      },
    });

    const previewMap = await loadCreatorToolPreviewMap({
      seedItems: [
        {
          id: 'image-1',
          mediaUrl: 'https://example.com/image.jpg',
          mediaKind: 'image',
          model: 'nano-banana-2',
          title: 'Image',
          prompt: '',
          body: '',
          category: 'image',
          postFormat: 'media',
          saveCount: 0,
          remixCount: 0,
          commentCount: 0,
          createdAt: '2026-04-08T00:00:00.000Z',
          creator: { id: 'creator-1', username: 'creator-1', name: 'Creator 1', avatar: null },
          sourceKind: 'magicbooklet',
          sourceTool: null,
          generationId: 'gen-image-1',
          asset: null,
          canRemix: true,
        },
        {
          id: 'video-1',
          mediaUrl: 'https://example.com/video.mp4',
          mediaKind: 'video',
          model: 'kling-3.0-video',
          title: 'Video',
          prompt: '',
          body: '',
          category: 'video',
          postFormat: 'media',
          saveCount: 0,
          remixCount: 0,
          commentCount: 0,
          createdAt: '2026-04-08T00:00:00.000Z',
          creator: { id: 'creator-2', username: 'creator-2', name: 'Creator 2', avatar: null },
          sourceKind: 'magicbooklet',
          sourceTool: null,
          generationId: 'gen-video-1',
          asset: null,
          canRemix: true,
        },
      ],
    });

    expect(previewMap.motion?.id).toBe('motion-1');
    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith({
      category: 'video',
      sort: 'top-saves',
      offset: 0,
      limit: 12,
      viewerUserId: null,
    });
  });
});
