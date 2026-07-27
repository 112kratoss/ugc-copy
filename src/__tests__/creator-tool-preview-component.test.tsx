import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CreatorToolPreview } from '@/app/components/CreatorToolPreview';
import type { ShowcaseFeedItem } from '@/lib/showcase';

vi.mock('@/app/components/HoverVideo', () => ({
  HoverVideo: ({ src, poster }: { src: string; poster?: string | null }) => (
    <video data-testid="tool-preview-video" data-original-src={src} poster={poster ?? undefined} />
  ),
}));

function createItem(mediaKind: 'image' | 'video'): ShowcaseFeedItem {
  const extension = mediaKind === 'video' ? 'mp4' : 'jpg';
  const mediaUrl = `https://example.com/original.${extension}`;

  return {
    id: 'item-1',
    mediaUrl,
    mediaKind,
    mediaItems: [{
      id: 'media-1',
      url: mediaUrl,
      previewUrl: 'https://example.com/preview.webp',
      mediaKind,
      contentType: mediaKind === 'video' ? 'video/mp4' : 'image/jpeg',
      originalName: `original.${extension}`,
      width: 1080,
      height: 1350,
      durationSeconds: mediaKind === 'video' ? 8 : null,
      sortOrder: 0,
    }],
    model: 'test-model',
    title: 'Creator preview',
    prompt: '',
    body: '',
    category: mediaKind,
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-07-15T00:00:00.000Z',
    creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: 'generation-1',
    asset: null,
    canRemix: false,
  };
}

describe('CreatorToolPreview', () => {
  it('uses the existing lightweight preview for an image card', () => {
    render(
      <CreatorToolPreview
        item={createItem('image')}
        alt="Image creator"
        className="object-cover"
      />
    );

    expect(screen.getByRole('img', { name: 'Image creator' }))
      .toHaveAttribute('src', 'https://example.com/preview.webp');
  });

  it('prioritizes only the lightweight image preview when requested', () => {
    render(
      <CreatorToolPreview
        item={createItem('image')}
        alt="Image creator"
        className="object-cover"
        priority
      />
    );

    const image = screen.getByRole('img', { name: 'Image creator' });
    expect(image).toHaveAttribute('src', 'https://example.com/preview.webp');
    expect(image).toHaveAttribute('fetchpriority', 'high');
    expect(image).toHaveAttribute('loading', 'eager');
  });

  it('uses the existing lightweight preview as a video poster', () => {
    render(
      <CreatorToolPreview
        item={createItem('video')}
        alt="Video creator"
        className="object-cover"
      />
    );

    const video = screen.getByTestId('tool-preview-video');
    expect(video).toHaveAttribute('poster', 'https://example.com/preview.webp');
    expect(video).toHaveAttribute('data-original-src', 'https://example.com/original.mp4');
    expect(video).not.toHaveAttribute('src');
  });
});
