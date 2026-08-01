import { describe, expect, it } from 'vitest';

import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import {
  buildProfileFeedCards,
  getProfileFeedMediaHeight,
  toProfileFeedCard,
} from '../lib/profile-feed-card-view-model';

const NOW = new Date('2026-08-01T12:00:00.000Z');

function media(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-1',
    url: 'https://cdn.test/a.png',
    mediaKind: 'image' as const,
    contentType: null,
    originalName: null,
    width: 1024,
    height: 1024,
    durationSeconds: null,
    sortOrder: 0,
    ...overrides,
  } as ImmersivePreviewItem['mediaItems'][number];
}

function item(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'gen-1',
    source: 'profile-creations',
    sourceType: 'generation',
    title: 'Minnal murali female version',
    displayText: 'Minnal murali female version',
    mediaUrl: 'https://cdn.test/a.png',
    mediaKind: 'image',
    mediaItems: [media()],
    creatorLabel: '@batman',
    creatorAvatar: null,
    createdAt: '2026-07-31T12:00:00.000Z',
    badge: 'Image',
    saveLabel: 'Saved',
    saveCount: 0,
    commentLabel: '0',
    commentCount: 0,
    canComment: false,
    isSaved: true,
    canSave: false,
    canShare: true,
    sharePath: null,
    recreateTool: 'image',
    recreatePrompt: 'prompt',
    showcasePostId: null,
    generationId: 'gen-1',
    ownerPostId: null,
    availableActions: [],
    disabledActions: {},
    ...overrides,
  };
}

describe('profile feed card view model', () => {
  it('drops a body that only repeats the title', () => {
    // The card would otherwise print the same sentence twice, once as the
    // headline and once as the caption.
    const card = toProfileFeedCard(item(), NOW);
    expect(card.title).toBe('Minnal murali female version');
    expect(card.bodyText).toBe('');
  });

  it('keeps a body that genuinely differs from the title', () => {
    const card = toProfileFeedCard(item({
      title: 'Lightning portrait',
      details: {
        title: 'Lightning portrait',
        prompt: 'p',
        body: 'Shot in the rain outside the temple.',
        categoryLabel: 'Image',
        sourceLabel: 'Creations',
        creatorLabel: '@batman',
        creatorAvatar: null,
        saveCount: 0,
        remixCount: 0,
        unlock: null,
      },
    }), NOW);

    expect(card.bodyText).toBe('Shot in the rain outside the temple.');
  });

  it('carries the publish state onto the card', () => {
    expect(toProfileFeedCard(item(), NOW).state).toEqual({ label: 'Not posted', tone: 'neutral' });
    expect(toProfileFeedCard(item({
      linkedPostId: 'post-1',
      linkedPostVisibility: 'public',
    }), NOW).state).toEqual({ label: 'Public post', tone: 'success' });
  });

  it('surfaces a paid unlock as a banner', () => {
    const card = toProfileFeedCard(item({
      sourceType: 'owner-post',
      details: {
        title: 'Post',
        prompt: '',
        body: '',
        categoryLabel: 'Image',
        sourceLabel: 'Post',
        creatorLabel: '@batman',
        creatorAvatar: null,
        saveCount: 0,
        remixCount: 0,
        unlock: {
          resourceId: 'res-1',
          postId: 'post-1',
          title: 'Post',
          accessMode: 'paid',
          priceLabel: '$4.00',
          previewText: 'Prompt plus the workflow file.',
          resourceKinds: ['prompt', 'workflow'],
          allowRemix: false,
        },
      },
    }), NOW);

    expect(card.unlockLabel).toBe('$4.00');
    expect(card.unlockSummary).toBe('Prompt plus the workflow file.');
  });

  it('picks an accent from the media kind', () => {
    expect(toProfileFeedCard(item(), NOW).accent).toBe('image');
    expect(toProfileFeedCard(item({ mediaKind: 'video' }), NOW).accent).toBe('video');
    expect(toProfileFeedCard(item({ previewKind: 'text' }), NOW).accent).toBe('amber');
  });

  it('treats a text-only item as having no media', () => {
    const card = toProfileFeedCard(item({ previewKind: 'text' }), NOW);
    expect(card.hasMedia).toBe(false);
    expect(getProfileFeedMediaHeight(card, 360)).toBe(0);
  });

  it('clamps media height so a tall creation cannot fill the whole card', () => {
    const tall = toProfileFeedCard(item({
      mediaItems: [media({ width: 512, height: 2048 })],
    }), NOW);
    // 1:4 would be 1440pt at a 360pt width; the ratio ceiling caps it.
    expect(getProfileFeedMediaHeight(tall, 360)).toBe(450);

    const wide = toProfileFeedCard(item({
      mediaItems: [media({ width: 2048, height: 512 })],
    }), NOW);
    expect(getProfileFeedMediaHeight(wide, 360)).toBe(180);
  });

  it('builds a card per item', () => {
    const cards = buildProfileFeedCards([item(), item({ id: 'gen-2' })], NOW);
    expect(cards.map((card) => card.id)).toEqual(['gen-1', 'gen-2']);
  });
});
