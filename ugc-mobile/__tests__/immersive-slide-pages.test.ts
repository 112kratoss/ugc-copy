import { describe, expect, it } from 'vitest';

import {
  buildImmersiveSlidePages,
  getImmersiveSlideHint,
  getImmersiveVideoBlockerId,
  isImmersiveDetailsSlidePageIndex,
} from '../lib/immersive-slide-pages';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import type { ShowcaseMediaItem } from '../lib/types';

function media(id: string, mediaKind: 'image' | 'video' = 'image'): ShowcaseMediaItem {
  return {
    id,
    url: `https://cdn.example.com/${id}.${mediaKind === 'video' ? 'mp4' : 'jpg'}`,
    mediaKind,
    contentType: null,
    originalName: null,
    width: null,
    height: null,
    durationSeconds: null,
    sortOrder: 0,
  };
}

function item(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'post-1',
    source: 'showcase-feed',
    sourceType: 'showcase',
    title: 'Post',
    displayText: 'Caption',
    mediaUrl: 'https://cdn.example.com/post.jpg',
    mediaKind: 'image',
    mediaItems: [media('post-1')],
    creatorLabel: '@creator',
    creatorAvatar: null,
    badge: 'Image',
    saveLabel: '0',
    commentLabel: '0',
    commentCount: 0,
    canComment: false,
    saveCount: 0,
    isSaved: false,
    canSave: true,
    canShare: true,
    sharePath: '/showcase/post-1',
    recreateTool: 'image',
    recreatePrompt: 'Prompt',
    showcasePostId: 'post-1',
    generationId: null,
    ownerPostId: null,
    details: {
      title: 'Post',
      prompt: 'Prompt',
      body: 'Caption',
      categoryLabel: 'Image',
      sourceLabel: 'Showcase',
      creatorLabel: '@creator',
      creatorAvatar: null,
      saveCount: 0,
      remixCount: 0,
      unlock: null,
    },
    availableActions: ['view-details'],
    disabledActions: {},
    ...overrides,
  };
}

describe('immersive slide pages', () => {
  it('puts details after a single media page', () => {
    const pages = buildImmersiveSlidePages(item({ mediaItems: [media('single')] }));

    expect(pages.map((page) => page.type)).toEqual(['media', 'details']);
    expect(isImmersiveDetailsSlidePageIndex(pages, 1)).toBe(true);
    expect(getImmersiveSlideHint({ item: item(), pages, currentHorizontalIndex: 0 })).toBe('Swipe left for details');
  });

  it('puts details after all media pages for multi-media posts', () => {
    const post = item({ mediaItems: [media('first'), media('second')] });
    const pages = buildImmersiveSlidePages(post);

    expect(pages.map((page) => page.type)).toEqual(['media', 'media', 'details']);
    expect(getImmersiveSlideHint({ item: post, pages, currentHorizontalIndex: 0 })).toBe('Swipe left for more media');
    expect(getImmersiveSlideHint({ item: post, pages, currentHorizontalIndex: 1 })).toBe('Swipe left for details');
    expect(getImmersiveSlideHint({ item: post, pages, currentHorizontalIndex: 2 })).toBe('Swipe right for media');
  });

  it('puts details after text posts', () => {
    const post = item({
      mediaItems: [],
      mediaKind: null,
      previewKind: 'text',
    });
    const pages = buildImmersiveSlidePages(post);

    expect(pages.map((page) => page.type)).toEqual(['text', 'details']);
    expect(getImmersiveSlideHint({ item: post, pages, currentHorizontalIndex: 0 })).toBe('Swipe left for details');
    // A text post has no media to swipe back to.
    expect(getImmersiveSlideHint({ item: post, pages, currentHorizontalIndex: 1 })).toBe('Swipe right for the post');
  });

  it('adds a details page for creation-only generation items', () => {
    // Creations open in the reel like everything else, so the swipe-left details page
    // is the only place their model/cost metadata can be shown.
    const generation = item({
      source: 'profile-creations',
      sourceType: 'generation',
      showcasePostId: null,
      generationId: 'gen-1',
    });

    expect(buildImmersiveSlidePages(generation).map((page) => page.type)).toEqual(['media', 'details']);
  });

  it('blocks active video playback while details page, details sheet, or action sheet is open', () => {
    expect(getImmersiveVideoBlockerId({
      detailsPageOpenItemId: 'post-1',
      detailsSheetOpenItemId: null,
      actionsOpenItemId: null,
    })).toBe('post-1');
    expect(getImmersiveVideoBlockerId({
      detailsPageOpenItemId: null,
      detailsSheetOpenItemId: 'post-1',
      actionsOpenItemId: null,
    })).toBe('post-1');
    expect(getImmersiveVideoBlockerId({
      detailsPageOpenItemId: null,
      detailsSheetOpenItemId: null,
      actionsOpenItemId: 'post-1',
    })).toBe('post-1');
  });
});
