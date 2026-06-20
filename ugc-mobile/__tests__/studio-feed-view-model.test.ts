import { describe, expect, it } from 'vitest';

import { buildStudioCreationMasonry, filterStudioCreationCards, generationToStudioCreationCard } from '../lib/studio-feed-view-model';
import type { GenerationListItem } from '../lib/types';

function generation(overrides: Partial<GenerationListItem>): GenerationListItem {
  return {
    id: 'gen-1',
    output_url: null,
    status: 'succeeded',
    created_at: '2026-05-13T10:00:00.000Z',
    completed_at: '2026-05-13T10:05:00.000Z',
    cost: 2,
    model: 'test-model',
    category: 'image',
    title: 'Portrait',
    prompt: 'Create a cinematic portrait',
    ...overrides,
  };
}

describe('studio feed view model', () => {
  it('normalizes generations into feed-style creation cards', () => {
    expect(generationToStudioCreationCard(generation({
      id: 'motion-1',
      category: 'motion',
      output_url: 'https://example.com/motion.mp4',
      status: 'processing',
      title: null,
      prompt: 'Make the subject dance',
    }))).toMatchObject({
      id: 'motion-1',
      title: 'Make the subject dance',
      kind: 'motion',
      mediaKind: 'video',
      badge: 'Processing',
      accent: 'motion',
      height: 256,
      mediaUrl: 'https://example.com/motion.mp4',
      viewerSource: 'studio-creations',
      sourceId: 'motion-1',
    });
  });

  it('keeps text generations as prompt preview cards', () => {
    expect(generationToStudioCreationCard(generation({
      id: 'text-1',
      category: 'text',
      output_url: null,
      title: 'Launch caption',
      prompt: 'Write a high-converting caption for a skincare launch',
    }))).toMatchObject({
      id: 'text-1',
      kind: 'text',
      label: 'Text',
      badge: 'Text',
      accent: 'amber',
      mediaKind: null,
      mediaUrl: null,
      height: 218,
      viewerSource: 'studio-creations',
      sourceId: 'text-1',
    });
  });

  it('treats ugc-ad generations as video creation cards', () => {
    expect(generationToStudioCreationCard(generation({
      id: 'ugc-ad-1',
      category: 'ugc-ad',
      output_url: 'https://example.com/ugc-ad.mp4',
      title: 'Creator ad',
      prompt: 'A creator ad spot',
    }))).toMatchObject({
      id: 'ugc-ad-1',
      kind: 'video',
      label: 'Video',
      mediaKind: 'video',
      accent: 'video',
      height: 268,
    });
  });

  it('builds balanced two-column creation feed columns', () => {
    const columns = buildStudioCreationMasonry([
      generation({ id: 'image-1', category: 'image' }),
      generation({ id: 'video-1', category: 'video' }),
      generation({ id: 'motion-1', category: 'motion' }),
    ]);

    expect(columns).toHaveLength(2);
    expect(columns[0].map((card) => card.id)).toEqual(['image-1', 'motion-1']);
    expect(columns[1].map((card) => card.id)).toEqual(['video-1']);
  });

  it('filters creation cards by generation kind', () => {
    const cards = [
      generationToStudioCreationCard(generation({ id: 'image-1', category: 'image' })),
      generationToStudioCreationCard(generation({ id: 'video-1', category: 'video' })),
      generationToStudioCreationCard(generation({ id: 'motion-1', category: 'motion' })),
      generationToStudioCreationCard(generation({ id: 'text-1', category: 'text' })),
    ];

    expect(filterStudioCreationCards(cards, 'all')).toHaveLength(4);
    expect(filterStudioCreationCards(cards, 'video').map((card) => card.id)).toEqual(['video-1']);
    expect(filterStudioCreationCards(cards, 'text').map((card) => card.id)).toEqual(['text-1']);
  });
});
