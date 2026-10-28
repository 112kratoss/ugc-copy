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

/**
 * S1 (recipe audit 2026-10-27): on a post made from a creation, any published
 * recipe, free or paid, comes with Remix. The owner and anyone who unlocked it
 * remix as before; everyone else is sent through the unlock, and every read
 * says `allowRemix: true` for such a recipe whatever is stored.
 */
describe('getShowcaseRemixAccess once every creation recipe includes Remix', () => {
  const locked = { canRemix: false, remixCapability: 'unlock_required' as const, remixTarget: 'image' as const };

  it('sends a viewer without the recipe through its unlock, free or paid', () => {
    expect(getShowcaseRemixAccess(item({ ...locked, asset: asset({ accessMode: 'free' }) }))).toBe('free-unlock');
    expect(getShowcaseRemixAccess(item({ ...locked, asset: asset({ accessMode: 'paid', priceUsdCents: 900 }) }))).toBe('paid-unlock');
  });

  it('opens Remix for the owner and for anyone who unlocked it', () => {
    // The server answers `public` and `canRemix` for them.
    expect(getShowcaseRemixAccess(item({
      canRemix: true,
      remixCapability: 'public',
      remixTarget: 'image',
      asset: asset({ accessMode: 'paid', priceUsdCents: 900 }),
    }))).toBe('open');
  });

  it('leaves a creation without a recipe open, and an upload with nothing to remix', () => {
    expect(getShowcaseRemixAccess(item({ canRemix: true, remixCapability: 'public', remixTarget: 'image', asset: null }))).toBe('open');
    expect(getShowcaseRemixAccess(item({ generationId: null, canRemix: false, remixCapability: 'unsupported', asset: asset() }))).toBeNull();
  });

  it("believes the server's unlock over a recipe summary a read path has not normalised yet", () => {
    // The remix endpoint refuses this viewer until the recipe is unlocked, so
    // the recipe is the way in whatever its stored flag says.
    expect(getShowcaseRemixAccess(item({
      ...locked,
      asset: asset({ allowRemix: false, accessMode: 'paid', priceUsdCents: 900 }),
    }))).toBe('paid-unlock');
    expect(getShowcaseRemixAccess(item({
      ...locked,
      asset: asset({ allowRemix: false, accessMode: 'free' }),
    }))).toBe('free-unlock');
  });

  it('still offers nothing when the server says an unlock is needed but sends no recipe to unlock', () => {
    expect(getShowcaseRemixAccess(item({ ...locked, asset: null }))).toBeNull();
  });
});

