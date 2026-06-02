import { describe, expect, it } from 'vitest';

import {
  HOME_TOOL_SHORTCUTS,
  formatCompactCount,
  formatRelativeTime,
  formatUsdCents,
  generationsToHomeCards,
  getOwnerPostSalesSummary,
  generationToHomeCard,
  showcaseToCommunityCard,
} from '../lib/home-view-model';

describe('home view model', () => {
  it('describes mobile workspace creator paths with routes and the workflow teaser', () => {
    expect(HOME_TOOL_SHORTCUTS.map(({ id, accent, href, badge, previewVariant }) => ({ id, accent, href, badge, previewVariant }))).toEqual([
      { id: 'image', accent: 'image', href: '/create/image', badge: undefined, previewVariant: 'kingdom' },
      { id: 'video', accent: 'video', href: '/create/video', badge: undefined, previewVariant: 'city' },
      { id: 'motion', accent: 'motion', href: '/create/motion', badge: undefined, previewVariant: 'runner' },
      { id: 'workflow', accent: 'workflow', href: null, badge: 'Soon', previewVariant: null },
    ]);
  });

  it('formats compact counts and relative times for dashboard cards', () => {
    const now = new Date('2026-05-13T12:00:00.000Z');

    expect(formatCompactCount(96)).toBe('96');
    expect(formatCompactCount(1200)).toBe('1.2K');
    expect(formatCompactCount(1_000_000)).toBe('1M');
    expect(formatRelativeTime('2026-05-13T11:50:00.000Z', now)).toBe('10m ago');
    expect(formatRelativeTime('2026-05-12T10:00:00.000Z', now)).toBe('1d ago');
    expect(formatUsdCents(4280)).toBe('$42.80');
  });

  it('summarizes seller post earnings for the side menu wallet', () => {
    expect(getOwnerPostSalesSummary([
      {
        id: 'post-1',
        title: 'Portal pack',
        createdAt: '2026-05-13T10:00:00.000Z',
        visibility: 'public',
        mediaUrl: null,
        mediaKind: 'image',
        bundle: {
          id: 'bundle-1',
          accessMode: 'paid',
          status: 'published',
          priceUsdCents: 1200,
          salesCount: 2,
          earningsUsdCents: 2400,
          resourceKinds: ['prompt'],
        },
      },
      {
        id: 'post-2',
        title: 'Free notes',
        createdAt: '2026-05-13T11:00:00.000Z',
        visibility: 'public',
        mediaUrl: null,
        mediaKind: null,
        bundle: null,
      },
    ])).toEqual({ salesCount: 2, earningsUsdCents: 2400 });
  });

  it('normalizes generation cards for the recent creations rail', () => {
    expect(generationToHomeCard({
      id: 'gen-1',
      output_url: 'https://example.com/video.mp4',
      status: 'succeeded',
      created_at: '2026-05-13T11:00:00.000Z',
      model: 'model',
      category: 'motion',
      title: null,
      prompt: 'Astronaut running',
    })).toMatchObject({
      id: 'gen-1',
      title: 'Astronaut running',
      kind: 'motion',
      label: 'Motion',
      mediaUrl: 'https://example.com/video.mp4',
      artVariant: 'runner',
      viewerSource: 'home-creations',
      sourceId: 'gen-1',
    });

    expect(generationToHomeCard({
      id: 'text-1',
      output_url: null,
      status: 'succeeded',
      created_at: '2026-05-13T11:00:00.000Z',
      model: 'copy-model',
      category: 'text',
      title: 'Launch caption',
      prompt: 'Write a launch caption for a skincare reel',
    })).toMatchObject({
      id: 'text-1',
      title: 'Launch caption',
      kind: 'text',
      label: 'Text',
      mediaUrl: null,
      previewText: 'Write a launch caption for a skincare reel',
      viewerSource: 'home-creations',
      sourceId: 'text-1',
    });
  });

  it('does not invent recent studio cards when no generations exist', () => {
    expect(generationsToHomeCards([])).toEqual([]);
  });

  it('normalizes showcase posts for the community feed', () => {
    const card = showcaseToCommunityCard({
      id: 'post-1',
      mediaUrl: null,
      mediaKind: null,
      model: 'manual',
      title: 'Beauty Hook',
      prompt: 'Prompt',
      body: 'Post body',
      category: 'image',
      postFormat: 'text',
      saveCount: 1200,
      remixCount: 96,
      createdAt: '2026-05-13T10:00:00.000Z',
      creator: { id: 'user-1', username: 'luna', name: 'LunaDreams', avatar: null },
      generationId: null,
      asset: {
        id: 'asset-1',
        postId: 'post-1',
        title: 'Unlock',
        accessMode: 'paid',
        priceUsdCents: 900,
        previewText: 'Preview',
        allowRemix: false,
      },
      canRemix: false,
    });

    expect(card).toMatchObject({
      creatorName: 'LunaDreams',
      creatorHandle: '@luna',
      body: 'Post body',
      previewKind: 'text',
      saveLabel: '1.2K',
      accessLabel: 'Paywalled',
      viewerSource: 'home-community',
      sourceId: 'post-1',
    });
    expect(card).not.toHaveProperty('remixLabel');
  });

  it('uses media previews for showcase posts with usable media', () => {
    expect(showcaseToCommunityCard({
      id: 'post-media',
      mediaUrl: 'https://example.com/post.png',
      mediaKind: 'image',
      model: 'manual',
      title: 'Image post',
      prompt: 'Prompt copy',
      body: 'Body copy',
      category: 'image',
      postFormat: 'media',
      saveCount: 0,
      remixCount: 0,
      createdAt: '2026-05-13T10:00:00.000Z',
      creator: { id: 'user-1', username: 'luna', name: 'LunaDreams', avatar: null },
      generationId: null,
      asset: null,
      canRemix: false,
    })).toMatchObject({
      body: 'Body copy',
      previewKind: 'media',
      mediaUrl: 'https://example.com/post.png',
    });
  });

  it('falls back through body, prompt, and title for showcase text previews', () => {
    const basePost = {
      id: 'post-text',
      mediaUrl: null,
      mediaKind: null,
      model: 'manual',
      category: 'image',
      postFormat: 'text',
      saveCount: 0,
      remixCount: 0,
      createdAt: '2026-05-13T10:00:00.000Z',
      creator: { id: 'user-1', username: 'luna', name: 'LunaDreams', avatar: null },
      generationId: null,
      asset: null,
      canRemix: false,
    } as const;

    expect(showcaseToCommunityCard({ ...basePost, title: 'Title copy', prompt: 'Prompt copy', body: 'Body copy' }).body).toBe('Body copy');
    expect(showcaseToCommunityCard({ ...basePost, title: 'Title copy', prompt: 'Prompt copy', body: '' }).body).toBe('Prompt copy');
    expect(showcaseToCommunityCard({ ...basePost, title: 'Title copy', prompt: '', body: '' }).body).toBe('Title copy');
  });
});
