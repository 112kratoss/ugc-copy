import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  buildViewerItems,
  loadImmersiveSourceData,
  readCachedImmersiveSourceSnapshot,
} from '../lib/immersive-preview-source-data';
import { buildImmersiveGenerationItems, getImmersiveInitialIndex } from '../lib/immersive-preview-view-model';
import { getShowcaseViewerImageUrl } from '../lib/showcase-media';
import type { GenerationListItem } from '../lib/types';

/**
 * The five desired-contract checks from the 2026-09-16 Creations reliability
 * audit (docs/audits/creations-reliability-plan.md, C1–C5). Every one failed
 * against the audited source; they stay here as the regressions for the fixes.
 */

const owner = { creatorLabel: '@creator', creatorAvatar: null, creatorId: 'user-1' };

function generation(id: string, overrides: Partial<GenerationListItem> = {}): GenerationListItem {
  return {
    id,
    output_url: `https://cdn.example.com/${id}.png`,
    status: 'succeeded',
    created_at: '2026-09-02T10:00:00.000Z',
    completed_at: '2026-09-02T10:01:00.000Z',
    model: 'nano-banana-2',
    category: 'image',
    title: id,
    prompt: 'A prompt.',
    ...overrides,
  };
}

/**
 * What the owner route answers for a creation whose only source is gone: every
 * address withheld, `source_unavailable_at` kept as the signal.
 */
function unavailableGeneration(id: string) {
  return generation(id, {
    output_url: null,
    preview_url: null,
    previewUrl: null,
    media: null,
    source_unavailable_at: '2026-09-08T06:15:00.000Z',
  });
}

function stubApi(overrides: Record<string, unknown> = {}) {
  return {
    getCreatorProfile: vi.fn(),
    getSavedMedia: vi.fn(),
    getShowcaseFeed: vi.fn(),
    getShowcasePost: vi.fn(),
    getOwnerPost: vi.fn(),
    listGenerations: vi.fn(async () => ({ generations: [] as GenerationListItem[] })),
    listOwnerPosts: vi.fn(async () => ({ success: true, posts: [] })),
    ...overrides,
  };
}

describe('Creations reliability audit regressions', () => {
  it('C1: tapping an unavailable creation lands on that creation, never the first one', () => {
    const data = { generations: [generation('first'), unavailableGeneration('dress-change')] };

    // The card feed builds its items without the selected id; the reel passes it.
    for (const items of [
      buildViewerItems('profile-creations', data, owner),
      buildViewerItems('profile-creations', data, owner, 'dress-change'),
    ]) {
      const index = getImmersiveInitialIndex(items, 'dress-change');
      expect(items[index]?.id).toBe('dress-change');
      // Its missing source is never handed to an image or a player.
      expect(items[index]?.mediaItems).toEqual([]);
    }
  });

  it('C2: the display rendition survives the owner-generation adapter', () => {
    const url = 'https://storage.example.com/owner/full.png';
    const displayUrl = 'https://storage.example.com/owner/full.display.webp';
    const [item] = buildImmersiveGenerationItems('profile-creations', [generation('photo', {
      output_url: url,
      media: {
        id: 'photo',
        kind: 'image',
        url,
        displayUrl,
        previewUrl: 'https://storage.example.com/owner/full.preview.webp',
        thumbhash: null,
        cacheKey: 'owner/full.preview.webp',
        expiresAt: null,
        width: 720,
        height: 960,
        durationSeconds: null,
        status: 'ready',
        gridReady: true,
      },
    })], owner);

    expect(getShowcaseViewerImageUrl(item.mediaItems[0])).toBe(displayUrl);
  });

  it('C3: archived creations stay out of the normal Creations viewer', async () => {
    const items = buildViewerItems('profile-creations', {
      generations: [generation('kept'), generation('archived', { archived_at: '2026-09-10T00:00:00.000Z' })],
    }, owner);
    expect(items.map((item) => item.id)).toEqual(['kept']);

    const api = stubApi();
    await loadImmersiveSourceData({ api, source: 'profile-creations', initialId: '' });
    expect(api.listGenerations).toHaveBeenCalledWith(false, { limit: 48 });
  });

  it('C4: hydrating a viewer from another cache keeps that cache\'s age', () => {
    const queryClient = new QueryClient();
    const anHourAgo = Date.now() - 60 * 60 * 1000;
    queryClient.setQueryData(['profile-generations', 'user-1'], {
      pages: [{ generations: [generation('gen-1')] }],
      pageParams: [null],
    }, { updatedAt: anHourAgo });

    const snapshot = readCachedImmersiveSourceSnapshot(queryClient, 'home-creations', 'user-1', 'gen-1');
    expect(snapshot?.updatedAt).toBe(anHourAgo);
  });

  it('C5: an owner-post failure does not discard the creations that loaded', async () => {
    const api = stubApi({
      listGenerations: vi.fn(async () => ({ generations: [generation('playable')] })),
      listOwnerPosts: vi.fn(async () => { throw new Error('Internal Server Error'); }),
    });

    const data = await loadImmersiveSourceData({ api, source: 'studio-creations', initialId: 'playable' });
    expect(data.generations?.map((item) => item.id)).toEqual(['playable']);
  });
});
