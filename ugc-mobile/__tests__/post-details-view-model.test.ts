import { describe, expect, it } from 'vitest';

import type { ImmersivePostUnlockDetails, ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import {
  buildGenerationStats,
  buildPostDetailsMeta,
  formatReturnedCredits,
  getDetailsBackLabel,
  getDetailsPrimaryAction,
  getDetailsTitle,
  getResourceSectionState,
  getUnlockPriceLabel,
  prepareUnlockedResourcesForDetails,
  readPostDetailsSection,
} from '@/lib/post-details-view-model';
import type { PostResourceBundleResources, PostResourceItem } from '@/lib/types';

const NOW = new Date('2026-08-23T12:00:00.000Z');

function showcaseItem(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'post-1',
    source: 'showcase-feed',
    sourceType: 'showcase',
    title: 'Minnal Murali',
    displayText: 'Minnal Murali',
    creatorLabel: '@batman',
    creatorUsername: 'batman',
    createdAt: '2026-08-23T09:00:00.000Z',
    saveCount: 0,
    commentCount: 0,
    availableActions: ['save', 'comment', 'share', 'recreate', 'view-details'],
    details: {
      title: 'Minnal Murali',
      prompt: '',
      body: '',
      categoryLabel: 'Image',
      sourceLabel: 'Showcase',
      toolLabel: null,
      creatorLabel: '@batman',
      creatorAvatar: null,
      saveCount: 0,
      remixCount: 0,
      unlock: null,
    },
    ...overrides,
  } as unknown as ImmersivePreviewItem;
}

function unlock(overrides: Partial<ImmersivePostUnlockDetails> = {}): ImmersivePostUnlockDetails {
  return {
    resourceId: 'asset-1',
    postId: 'post-1',
    title: 'Minnal Murali',
    accessMode: 'free',
    priceLabel: 'Free',
    previewText: null,
    resourceKinds: ['prompt', 'notes', 'remix'],
    allowRemix: true,
    ...overrides,
  };
}

function resourceItem(overrides: Partial<PostResourceItem> & Pick<PostResourceItem, 'type' | 'title'>): PostResourceItem {
  return {
    id: `${overrides.type}-${overrides.title}`,
    scope: { kind: 'all' },
    role: 'primary',
    sectionId: null,
    description: null,
    textContent: null,
    externalUrl: null,
    storagePath: null,
    contentType: null,
    sizeBytes: null,
    workflowSnapshot: null,
    sortOrder: 0,
    isPrimary: false,
    remixUse: 'none',
    ...overrides,
  };
}

function resources(overrides: Partial<PostResourceBundleResources> = {}): PostResourceBundleResources {
  return {
    promptText: null,
    notesMarkdown: null,
    workflowShareUrl: null,
    workflowSnapshot: null,
    attachments: [],
    allowRemix: false,
    ...overrides,
  };
}

describe('buildPostDetailsMeta', () => {
  it('leads with the kind and leaves zero counts out', () => {
    const meta = buildPostDetailsMeta(showcaseItem(), NOW);

    expect(meta.creatorLabel).toBe('@batman');
    expect(meta.timeLabel).toBe('3h ago');
    expect(meta.metaParts).toEqual(['Image']);
  });

  it('adds social proof and the tool once they exist', () => {
    const item = showcaseItem({
      saveCount: 1200,
      commentCount: 1,
      details: { ...showcaseItem().details!, remixCount: 3, toolLabel: 'Nano Banana' },
    });

    expect(buildPostDetailsMeta(item, NOW).metaParts).toEqual([
      'Image',
      '1.2K saves',
      '3 remixes',
      '1 comment',
      'Made with Nano Banana',
    ]);
  });

  // The Comments button carries the count where it is drawn ("3"), so the line under the title
  // does not say it again (owner's call on A5, 2026-10-21).
  it('leaves the comment count to the Comments button where the page draws one', () => {
    const item = showcaseItem({ saveCount: 2, commentCount: 3 });

    expect(buildPostDetailsMeta(item, NOW, { commentsOnButton: true }).metaParts).toEqual(['Image', '2 saves']);
    expect(buildPostDetailsMeta(item, NOW).metaParts).toEqual(['Image', '2 saves', '3 comments']);
  });

  it('does not credit the app to itself', () => {
    const item = showcaseItem({ details: { ...showcaseItem().details!, toolLabel: 'magicbooklet' } });

    expect(buildPostDetailsMeta(item, NOW).metaParts).toEqual(['Image']);
  });

  it('has no time label when the source carries no timestamp', () => {
    expect(buildPostDetailsMeta(showcaseItem({ createdAt: null }), NOW).timeLabel).toBe('');
  });

  // Decision 13 (2026-10-17): the page names the model, as the cards have
  // since #452, by the feed card's rule (`homeModelLabel`): the catalog's
  // display name, never a slug, and nothing for a text post or an unknown id.
  describe('what the post was made with', () => {
    function madeWith(model: string | null, toolLabel: string | null = null, overrides: Partial<ImmersivePreviewItem> = {}) {
      const item = showcaseItem({ ...overrides, details: { ...showcaseItem().details!, model, toolLabel } });
      return buildPostDetailsMeta(item, NOW).metaParts;
    }

    it('names a model the catalog knows by its display name, in place of the tool', () => {
      expect(madeWith('imagen-4', 'magicbooklet')).toEqual(['Image', 'Made with Imagen 4']);
      expect(madeWith('imagen-4', 'Midjourney')).toEqual(['Image', 'Made with Imagen 4']);
    });

    it('never prints a slug, and keeps an outside tool the creator named', () => {
      expect(madeWith('some-unknown-model')).toEqual(['Image']);
      expect(madeWith('manual', 'magicbooklet')).toEqual(['Image']);
      expect(madeWith('manual', 'Midjourney')).toEqual(['Image', 'Made with Midjourney']);
    });

    it('names nothing on a text post', () => {
      const textPost = { previewKind: 'text' as const };
      expect(madeWith('imagen-4', null, textPost)).toEqual(['Image']);
    });
  });
});

describe('getDetailsPrimaryAction', () => {
  it('calls remixing someone else\'s post a remix', () => {
    expect(getDetailsPrimaryAction(showcaseItem(), { canAccess: false })).toEqual({ label: 'Remix' });
  });

  it('calls running your own creation again a recreate', () => {
    const own = showcaseItem({ sourceType: 'generation', availableActions: ['recreate', 'share', 'view-details'] });

    expect(getDetailsPrimaryAction(own, { canAccess: false })).toEqual({ label: 'Recreate' });
  });

  it('has no primary for a locked paid post — the resources card sells it', () => {
    const locked = showcaseItem({ availableActions: ['save', 'unlock-remix', 'view-details'] });

    expect(getDetailsPrimaryAction(locked, { canAccess: false })).toBeNull();
  });

  it('treats a stale unlock-remix as a remix once the bundle is accessible', () => {
    const purchased = showcaseItem({ availableActions: ['save', 'unlock-remix', 'view-details'] });

    expect(getDetailsPrimaryAction(purchased, { canAccess: true })).toEqual({ label: 'Remix' });
  });
});

describe('getUnlockPriceLabel', () => {
  it('says Free before and after the bundle loads', () => {
    expect(getUnlockPriceLabel(unlock(), undefined)).toBe('Free');
    expect(getUnlockPriceLabel(unlock(), { priceUsdCents: 0 })).toBe('Free');
  });

  it('prices a paid bundle in credits, from the loaded bundle once it arrives', () => {
    const paid = unlock({ accessMode: 'paid', priceLabel: '400 credits' });

    expect(getUnlockPriceLabel(paid, undefined)).toBe('400 credits');
    // A creator can reprice after the feed was read; the loaded record wins.
    expect(getUnlockPriceLabel(paid, { priceUsdCents: 1200 })).toBe('1,200 credits');
  });

  it('is nothing without an unlock', () => {
    expect(getUnlockPriceLabel(null, undefined)).toBeNull();
  });
});

describe('getResourceSectionState', () => {
  it('stays loading until the bundle exists, even when the query is idle', () => {
    expect(getResourceSectionState({ hasUnlock: true, bundle: undefined, isError: false })).toBe('loading');
  });

  it('reports an error only once the request failed without data', () => {
    expect(getResourceSectionState({ hasUnlock: true, bundle: null, isError: true })).toBe('error');
  });

  it('reads access off the bundle', () => {
    expect(getResourceSectionState({ hasUnlock: true, bundle: { viewerCanAccess: true }, isError: false })).toBe('unlocked');
    expect(getResourceSectionState({ hasUnlock: true, bundle: { viewerCanAccess: false }, isError: false })).toBe('locked');
  });

  it('is none for a post without an unlock', () => {
    expect(getResourceSectionState({ hasUnlock: false, bundle: undefined, isError: false })).toBe('none');
  });
});

describe('prepareUnlockedResourcesForDetails', () => {
  it('turns remix access into a flag instead of a card', () => {
    const prepared = prepareUnlockedResourcesForDetails(resources({
      items: [
        resourceItem({ type: 'prompt', title: 'Prompt', textContent: 'A glossy product photo' }),
        resourceItem({ type: 'remix_access', title: 'Remix access' }),
      ],
    }), { detailsPrompt: '' });

    expect(prepared.hasRemixAccess).toBe(true);
    expect(prepared.resources.items?.map((item) => item.type)).toEqual(['prompt']);
    expect(prepared.resources.allowRemix).toBe(false);
    expect(prepared.isEmpty).toBe(false);
  });

  it('drops a bundle prompt the page already printed', () => {
    const prepared = prepareUnlockedResourcesForDetails(resources({
      items: [resourceItem({ type: 'prompt', title: 'Prompt', textContent: '  A glossy   product photo ' })],
    }), { detailsPrompt: 'A glossy product photo' });

    expect(prepared.resources.items).toEqual([]);
    expect(prepared.isEmpty).toBe(true);
    expect(prepared.hasRemixAccess).toBe(false);
  });

  it('keeps a prompt that says something new', () => {
    const prepared = prepareUnlockedResourcesForDetails(resources({
      items: [resourceItem({ type: 'prompt', title: 'Prompt', textContent: 'Negative: blur, text' })],
    }), { detailsPrompt: 'A glossy product photo' });

    expect(prepared.resources.items).toHaveLength(1);
    expect(prepared.isEmpty).toBe(false);
  });

  it('handles the legacy flat shape the same way', () => {
    const prepared = prepareUnlockedResourcesForDetails(resources({
      promptText: 'A glossy product photo',
      allowRemix: true,
    }), { detailsPrompt: 'a glossy product photo' });

    expect(prepared.hasRemixAccess).toBe(true);
    expect(prepared.resources.promptText).toBeNull();
    expect(prepared.resources.allowRemix).toBe(false);
    expect(prepared.isEmpty).toBe(true);
  });

  it('is not empty while legacy notes or files remain', () => {
    const prepared = prepareUnlockedResourcesForDetails(resources({
      notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0',
    }), { detailsPrompt: '' });

    expect(prepared.isEmpty).toBe(false);
  });
});

describe('details chrome labels', () => {
  it('names the page after the way back', () => {
    expect(getDetailsBackLabel({ previewKind: 'text' })).toBe('Back to post');
    expect(getDetailsBackLabel({ previewKind: undefined })).toBe('Back to media');
  });

  it('titles a creation as a creation', () => {
    expect(getDetailsTitle(showcaseItem())).toBe('Details');
    expect(getDetailsTitle(showcaseItem({
      details: { ...showcaseItem().details!, generationInfo: { model: 'veo-3', createdAt: '', duration: 8, cost: null, inputMedia: null } },
    }))).toBe('Creation details');
  });
});

describe('the section a link opens the page on', () => {
  it('reads the sections the page has, a recipe opened from search leading with its resources', () => {
    expect(readPostDetailsSection('story')).toBe('story');
    expect(readPostDetailsSection('prompt')).toBe('prompt');
    expect(readPostDetailsSection('resources')).toBe('resources');
  });

  it('opens the page as usual for anything else', () => {
    for (const value of ['comments', 'Resources', 'recipe', '', null, undefined]) {
      expect(readPostDetailsSection(value)).toBeUndefined();
    }
  });
});

describe('what a failed run gave back', () => {
  it('reads "N credits returned" only when the run was refunded and had cost something', () => {
    expect(formatReturnedCredits({ cost: 40, refunded: true })).toBe('40 credits returned');
    expect(formatReturnedCredits({ cost: 1, refunded: true })).toBe('1 credit returned');
    expect(formatReturnedCredits({ cost: 1200, refunded: true })).toBe('1,200 credits returned');
    expect(formatReturnedCredits({ cost: 40, refunded: false })).toBeNull();
    expect(formatReturnedCredits({ cost: 0, refunded: true })).toBeNull();
    expect(formatReturnedCredits(null)).toBeNull();
  });

  // The tile it replaces said "Cost: 40 credits" for a run that cost nothing.
  it('turns the Cost tile of a refunded run into what came back', () => {
    expect(buildGenerationStats({ model: 'Seedance 2', duration: 5, cost: 40, refunded: true })).toEqual([
      { label: 'Model', value: 'Seedance 2' },
      { label: 'Duration', value: '5s' },
      { label: 'Returned', value: '40 credits' },
    ]);
    expect(buildGenerationStats({ model: 'Seedance 2', duration: 5, cost: 1, refunded: true })[2])
      .toEqual({ label: 'Returned', value: '1 credit' });
    expect(buildGenerationStats({ model: 'Seedance 2', duration: 5, cost: 40, refunded: false })[2])
      .toEqual({ label: 'Cost', value: '40 credits' });
  });
});

describe('a run that made several files', () => {
  // The slide shows one of them; the web Studio says how many (audit 01-2).
  it('says how many after what made it, before what it cost', () => {
    expect(buildGenerationStats({ model: 'Seedance 2', duration: 5, cost: 120, outputCount: 3 })).toEqual([
      { label: 'Model', value: 'Seedance 2' },
      { label: 'Duration', value: '5s' },
      { label: 'Outputs', value: '3' },
      { label: 'Cost', value: '120 credits' },
    ]);
  });

  it('has no Outputs tile for a run of one', () => {
    expect(buildGenerationStats({ model: 'GPT Image 2', cost: 8, outputCount: 1 }).map((stat) => stat.label))
      .toEqual(['Model', 'Cost']);
    expect(buildGenerationStats({ model: 'GPT Image 2', cost: 8, outputCount: null }).map((stat) => stat.label))
      .toEqual(['Model', 'Cost']);
  });
});
