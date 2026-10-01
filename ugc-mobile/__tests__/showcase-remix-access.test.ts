import { describe, expect, it } from 'vitest';

import { getShowcaseRemixAccess } from '@/lib/showcase-remix-access';
import type { ShowcaseAssetSummary, ShowcaseFeedItem } from '@/lib/types';

function item(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://cdn.example.test/post-1.mp4',
    mediaKind: 'video',
    model: 'Kling',
    title: 'Trending',
    prompt: '',
    body: '',
    category: 'video',
    postFormat: 'media',
    saveCount: 1,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-10-01T13:50:30.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: 'gen-1',
    asset: null,
    canRemix: true,
    ...overrides,
  } as ShowcaseFeedItem;
}

function asset(overrides: Partial<ShowcaseAssetSummary> = {}): ShowcaseAssetSummary {
  return {
    id: 'asset-1',
    postId: 'post-1',
    title: 'Trending',
    accessMode: 'free',
    priceUsdCents: 0,
    previewText: 'The prompt behind this video.',
    allowRemix: true,
    resourceKinds: ['prompt'],
    ...overrides,
  } as ShowcaseAssetSummary;
}

describe('getShowcaseRemixAccess', () => {
  it('is open for a creation the viewer may remix right now', () => {
    expect(getShowcaseRemixAccess(item())).toBe('open');
    // Unlocked, or the viewer's own post: the bundle no longer stands in the way.
    expect(getShowcaseRemixAccess(item({ asset: asset(), remixCapability: 'public', remixTarget: 'video' }))).toBe('open');
  });

  it('asks for the free unlock when remix sits behind one', () => {
    // What the feed sends for such a post to anyone who has not unlocked it.
    expect(getShowcaseRemixAccess(item({
      canRemix: false,
      remixCapability: 'unlock_required',
      remixTarget: 'video',
      asset: asset(),
    }))).toBe('free-unlock');
  });

  it('asks for the paid unlock when remix sits behind one', () => {
    expect(getShowcaseRemixAccess(item({
      canRemix: false,
      remixCapability: 'unlock_required',
      remixTarget: 'image',
      asset: asset({ accessMode: 'paid', priceUsdCents: 900 }),
    }))).toBe('paid-unlock');
  });

  it('reads the lock from the bundle when a source sends no capability', () => {
    // Saved media, creator profiles and pages kept from an older build carry
    // only `canRemix` and the bundle summary.
    expect(getShowcaseRemixAccess(item({ canRemix: false, asset: asset() }))).toBe('free-unlock');
    expect(getShowcaseRemixAccess(item({
      canRemix: false,
      asset: asset({ accessMode: 'paid', priceUsdCents: 500 }),
    }))).toBe('paid-unlock');
  });

  it('offers nothing for a post that was not made in the app', () => {
    expect(getShowcaseRemixAccess(item({ generationId: null }))).toBeNull();
    expect(getShowcaseRemixAccess(item({ generationId: '  ' }))).toBeNull();
    expect(getShowcaseRemixAccess(item({
      generationId: null,
      canRemix: false,
      remixCapability: 'unsupported',
      asset: asset(),
    }))).toBeNull();
  });

  it('offers nothing when the server rules a remix out', () => {
    // A covered mature post arrives stripped; a note has no creation to remix.
    expect(getShowcaseRemixAccess(item({
      generationId: null,
      canRemix: false,
      remixCapability: 'none',
      remixTarget: null,
      asset: null,
    }))).toBeNull();
    expect(getShowcaseRemixAccess(item({
      canRemix: false,
      remixCapability: 'none',
      asset: asset(),
    }))).toBeNull();
  });

  it('offers nothing when the unlock leads somewhere the app cannot open', () => {
    expect(getShowcaseRemixAccess(item({
      canRemix: false,
      remixCapability: 'unlock_required',
      remixTarget: 'workflow',
      asset: asset(),
    }))).toBeNull();
    expect(getShowcaseRemixAccess(item({
      canRemix: false,
      remixCapability: 'unlock_required',
      remixTarget: 'text_template',
      asset: asset(),
    }))).toBeNull();
  });

  it('offers nothing when the locked bundle does not include remix', () => {
    expect(getShowcaseRemixAccess(item({
      canRemix: false,
      asset: asset({ allowRemix: false }),
    }))).toBeNull();
  });
});
