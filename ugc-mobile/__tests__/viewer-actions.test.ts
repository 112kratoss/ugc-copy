import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildShareUrl,
  canSaveViewerItemOnDoubleTap,
  getDoubleTapSaveHeartAnimationSpec,
  getDoubleTapSaveHeartPalette,
  getDoubleTapSaveHeartPosition,
  getRailActionOpacity,
  getNativeRemixCreateHref,
  getSaveHeartIconProps,
  getSaveHeartTapAnimationSpec,
  getThemedSaveHeartIconProps,
  getDeleteCreationConfirmation,
  getProfileFeedCardSlots,
  getRemixSourceContext,
  getRemixSourceThumbnailUrl,
  getViewerActionGroupLabel,
  getViewerActionLabel,
  getViewerActionSlots,
  getViewerItemActionLabel,
  getViewerSafetyActions,
  getViewerShareIntent,
  getViewerShareSourceSurface,
  getViewerStateChip,
  isDestructiveViewerAction,
  isViewerOwnGeneration,
  SAVE_HEART_COLOR,
} from '../lib/viewer-actions';
import { contrastRatio } from '../lib/color-contrast';
import { hexWithAlpha } from '../lib/eased-fade';
import type { ImmersivePreviewItem, PreviewViewerSource } from '../lib/immersive-preview-view-model';
import { appTheme, themes } from '../lib/theme';

function railItem(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'item-1',
    source: 'profile-creations',
    sourceType: 'generation',
    title: 'Item',
    displayText: 'Item',
    mediaUrl: 'https://cdn.test/a.png',
    mediaKind: 'image',
    mediaItems: [],
    creatorLabel: '@creator',
    creatorAvatar: null,
    badge: 'Image',
    saveLabel: '0',
    saveCount: 0,
    commentLabel: '0',
    commentCount: 0,
    canComment: false,
    isSaved: false,
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

describe('viewer rail slots', () => {
  it('leads an unpublished creation with Publish and never renders a dead save slot', () => {
    const slots = getViewerActionSlots(railItem({
      availableActions: ['publish', 'recreate', 'archive', 'share', 'view-details'],
    }));

    expect(slots.map((slot) => slot.id)).toEqual(['publish', 'share', 'details', 'create']);
    expect(slots.find((slot) => slot.id === 'publish')).toMatchObject({
      action: 'publish',
      label: 'Publish',
      tone: 'primary',
    });
    expect(slots.some((slot) => slot.id === 'save')).toBe(false);
    expect(slots.some((slot) => slot.id === 'comment')).toBe(false);
  });

  it('swaps a published creation to visibility and unlock controls', () => {
    const slots = getViewerActionSlots(railItem({
      linkedPostId: 'post-1',
      linkedPostVisibility: 'public',
      availableActions: ['edit-linked-resources', 'change-linked-visibility', 'view-linked', 'recreate', 'share', 'view-details'],
    }));

    expect(slots.map((slot) => slot.id)).toEqual(['visibility', 'unlock', 'share', 'details', 'create']);
    // The rail names the linked post's current state; the action opens the
    // three-state picker, which the old public/private toggle could not reach
    // unlisted from.
    expect(slots.find((slot) => slot.id === 'visibility')).toMatchObject({
      action: 'change-linked-visibility',
      label: 'Public',
      a11yLabel: 'Change linked post visibility, currently public',
    });
    // No bundle attached yet, so the unlock slot invites creating one — the rail label
    // stays short and the full phrasing lives on the accessibility label.
    expect(slots.find((slot) => slot.id === 'unlock')).toMatchObject({
      label: 'Recipe',
      a11yLabel: 'Add a recipe',
    });
  });

  it('keeps save and comment for saved showcase media', () => {
    const slots = getViewerActionSlots(railItem({
      source: 'profile-saved',
      sourceType: 'showcase',
      showcasePostId: 'post-1',
      generationId: null,
      canSave: true,
      canComment: true,
      isSaved: true,
      commentCount: 4,
      commentLabel: '4',
      availableActions: ['unsave', 'comment', 'share', 'recreate', 'view-details'],
    }));

    expect(slots.map((slot) => slot.id)).toEqual(['save', 'comment', 'share', 'details', 'create']);
    expect(slots.find((slot) => slot.id === 'save')?.label).toBe('Saved');
    expect(slots.find((slot) => slot.id === 'comment')?.label).toBe('4');
    expect(slots.find((slot) => slot.id === 'create')?.label).toBe('Remix');
  });

  it('calls recreating your own creation a recreate, not a remix', () => {
    const slots = getViewerActionSlots(railItem({
      sourceType: 'generation',
      generationId: 'gen-1',
      availableActions: ['publish', 'recreate', 'share', 'view-details'],
    }));

    expect(slots.find((slot) => slot.id === 'create')?.label).toBe('Recreate');
  });

  it('drops ownership slots for an archived creation', () => {
    const slots = getViewerActionSlots(railItem({
      archivedAt: '2026-01-01T00:00:00.000Z',
      availableActions: ['restore', 'view-details'],
    }));

    expect(slots.map((slot) => slot.id)).toEqual(['share', 'details']);
  });
});

describe('viewer state chip', () => {
  it('reports creation publish state', () => {
    expect(getViewerStateChip(railItem())).toEqual({ label: 'Not posted', tone: 'neutral' });
    expect(getViewerStateChip(railItem({ linkedPostId: 'p1', linkedPostVisibility: 'public' })))
      .toEqual({ label: 'Public post', tone: 'success' });
    expect(getViewerStateChip(railItem({ linkedPostId: 'p1', linkedPostVisibility: 'private' })))
      .toEqual({ label: 'Private post', tone: 'warning' });
    expect(getViewerStateChip(railItem({ archivedAt: '2026-01-01T00:00:00.000Z' })))
      .toEqual({ label: 'Archived', tone: 'danger' });
  });

  it('reports owner post visibility and stays silent for showcase media', () => {
    expect(getViewerStateChip(railItem({ sourceType: 'owner-post', visibility: 'private' })))
      .toEqual({ label: 'Private post', tone: 'warning' });
    expect(getViewerStateChip(railItem({ sourceType: 'showcase' }))).toBeNull();
  });
});

describe('immersive viewer actions', () => {
  it('uses clear source-aware labels for owner and creation commands', () => {
    expect(getViewerActionLabel('save')).toBe('Save');
    expect(getViewerActionLabel('publish')).toBe('Post this creation');
    expect(getViewerActionLabel('edit-post')).toBe('Edit post');
    expect(getViewerActionLabel('view-linked')).toBe('View linked post');
    expect(getViewerActionLabel('view-details')).toBe('View details');
    expect(getViewerActionLabel('unlock-remix')).toBe('Remix');
    expect(getViewerActionLabel('delete-post')).toBe('Delete permanently');
  });

  it('uses one verb per source for making your own', () => {
    expect(getViewerActionLabel('recreate', 'showcase')).toBe('Remix');
    expect(getViewerActionLabel('recreate', 'generation')).toBe('Recreate');
    expect(getViewerActionLabel('recreate', 'owner-post')).toBe('Recreate');
    expect(getViewerActionLabel('recreate')).toBe('Recreate');
  });

  // HIG Action sheets: the destructive style is for buttons that perform
  // destructive actions. Saving and unsaving are the two halves of one
  // reversible toggle, so neither of them qualifies (S6).
  it('marks only removal-style commands as destructive', () => {
    expect(isDestructiveViewerAction('unsave')).toBe(false);
    expect(isDestructiveViewerAction('save')).toBe(false);
    expect(isDestructiveViewerAction('archive')).toBe(true);
    expect(isDestructiveViewerAction('delete-post')).toBe(true);
    expect(isDestructiveViewerAction('restore')).toBe(false);
    expect(isDestructiveViewerAction('share')).toBe(false);
  });

  // The two feed preferences remove nothing and report no one. Hiding a
  // creator was red in the reel's menu while a feed card's drew it plain.
  it('leaves the feed preferences plain, and keeps the safety rows red', () => {
    expect(isDestructiveViewerAction('not-interested')).toBe(false);
    expect(isDestructiveViewerAction('hide-creator')).toBe(false);
    for (const action of ['report-content', 'report-user', 'block-user', 'report-ai-output']) {
      expect(isDestructiveViewerAction(action)).toBe(true);
    }
  });

  // What a viewer may report or block from a viewer item's ••• (the reel, the
  // Details page, a profile card). A post is anyone's to report but its
  // creator's: Report content stayed on your own post until 2026-10-09, where
  // it filed a report on no one.
  it("offers a post's three Safety rows to anyone but its creator", () => {
    const post = { sourceType: 'showcase', creatorId: 'maya', generationId: null } as const;

    expect(getViewerSafetyActions(post, 'me')).toEqual(['report-content', 'report-user', 'block-user']);
    expect(getViewerSafetyActions(post, undefined)).toEqual(['report-content', 'report-user', 'block-user']);
    expect(getViewerSafetyActions(post, null)).toEqual(['report-content', 'report-user', 'block-user']);
    expect(getViewerSafetyActions({ ...post, creatorId: 'me' }, 'me')).toEqual([]);
    // No creator account: no one to report or block, and the post is no one's own.
    expect(getViewerSafetyActions({ ...post, creatorId: null }, 'me')).toEqual(['report-content']);
    expect(getViewerSafetyActions({ ...post, creatorId: undefined }, undefined)).toEqual(['report-content']);
  });

  it('offers a creation its own report, and a post from your profile none', () => {
    expect(getViewerSafetyActions({ sourceType: 'generation', creatorId: 'me', generationId: 'gen-1' }, 'me')).toEqual(['report-ai-output']);
    expect(getViewerSafetyActions({ sourceType: 'generation', creatorId: 'me', generationId: null }, 'me')).toEqual([]);
    // Whoever a creation's item names as its creator, it is not a post: no post row.
    expect(getViewerSafetyActions({ sourceType: 'generation', creatorId: null, generationId: 'gen-1' }, 'me')).toEqual(['report-ai-output']);
    expect(getViewerSafetyActions({ sourceType: 'owner-post', creatorId: 'maya', generationId: null }, 'me')).toEqual([]);
    expect(getViewerSafetyActions({ sourceType: 'owner-post', creatorId: 'me', generationId: null }, 'me')).toEqual([]);
    // A post that carries its creation's id is still a post.
    expect(getViewerSafetyActions({ sourceType: 'showcase', creatorId: 'me', generationId: 'gen-1' }, 'me')).toEqual([]);
  });

  // 02-2: a guest's own creation is the one thing the server takes a guest's
  // report about, so the row is offered for it and for nothing else.
  it("offers a guest the report on its own creation, and on no one else's", () => {
    const creation = { sourceType: 'generation', creatorId: undefined, generationId: 'gen-1' } as const;

    expect(getViewerSafetyActions(creation, 'guest-1')).toEqual(['report-ai-output']);
    expect(isViewerOwnGeneration(creation, 'guest-1')).toBe(true);
    // Its item names another creator: not the viewer's own.
    expect(getViewerSafetyActions({ ...creation, creatorId: 'maya' }, 'guest-1')).toEqual([]);
    expect(isViewerOwnGeneration({ ...creation, creatorId: 'maya' }, 'guest-1')).toBe(false);
    expect(isViewerOwnGeneration({ ...creation, creatorId: 'guest-1' }, 'guest-1')).toBe(true);
    // No identity at all, or no generation to report.
    expect(isViewerOwnGeneration(creation, undefined)).toBe(false);
    expect(isViewerOwnGeneration({ ...creation, generationId: null }, 'guest-1')).toBe(false);
    // A post's creation is its creator's, never a viewer's library item.
    expect(isViewerOwnGeneration({ sourceType: 'showcase', creatorId: 'maya', generationId: 'gen-1' }, 'guest-1')).toBe(false);
  });

  it('is the list the menu and its sheet are built from', () => {
    const source = readFileSync(path.resolve(__dirname, '../lib/use-viewer-action-handlers.ts'), 'utf8');

    // The viewer is the identity, a guest's included: a guest's own creations
    // are its library (02-1).
    expect(source).toContain('    ...getViewerSafetyActions(item, viewerId),\n  ];');
    // Nothing beside it adds a Safety row of its own.
    expect(source).not.toMatch(/\? \['(report-content|report-user|block-user|report-ai-output)'/);
  });

  it('groups creation-to-post actions separately from general media actions', () => {
    expect(getViewerActionGroupLabel('publish')).toBe('Creation to post');
    expect(getViewerActionGroupLabel('view-linked')).toBe('Creation to post');
    expect(getViewerActionGroupLabel('change-linked-visibility')).toBe('Creation to post');
    expect(getViewerActionGroupLabel('edit-post')).toBe('Your post');
    expect(getViewerActionGroupLabel('change-visibility')).toBe('Your post');
    expect(getViewerActionGroupLabel('archive')).toBe('Library');
    expect(getViewerActionGroupLabel('delete-post')).toBe('Library');
    expect(getViewerActionGroupLabel('share')).toBe('Media actions');
  });

  it('calls the destination Explore in the feed-preference group, not Showcase', () => {
    // The rename is easy to miss here: this label lives in a function rather
    // than in JSX, and ~40 legitimate uses of the old word survive as routes,
    // query keys and identifiers, so a grep for it is mostly noise.
    expect(getViewerActionGroupLabel('not-interested')).toBe('Explore preferences');
    expect(getViewerActionGroupLabel('hide-creator')).toBe('Explore preferences');
    expect(getViewerActionGroupLabel('report-content')).toBe('Safety');
  });

  it('fills the save heart when the post is already saved', () => {
    expect(getSaveHeartIconProps({ isSaved: true })).toMatchObject({
      color: '#ff3b64',
      fill: '#ff3b64',
    });
    expect(getSaveHeartIconProps({ isSaved: false })).toMatchObject({
      color: '#ffffff',
      fill: 'transparent',
    });
  });

  it('outlines the save heart on a card in ink that shows on every panel, in both schemes', () => {
    // The reel's white outline measured 1.16:1 on a light card. WCAG asks 3:1
    // of the parts of a control (1.4.11).
    const faint = (['light', 'dark'] as const).flatMap((scheme) => {
      const { colors } = themes[scheme];
      const { color } = getThemedSaveHeartIconProps({ isSaved: false, colors });
      return [colors.background, colors.panel, colors.panelSoft, colors.surfaceInset]
        .map((surface) => ({ surface, ratio: contrastRatio(color, surface) }))
        .filter(({ ratio }) => ratio < 3)
        .map(({ surface, ratio }) => `${scheme}: ${color} on ${surface} is ${ratio.toFixed(2)}:1`);
    });

    expect(faint).toEqual([]);
  });

  it('fills a saved heart on a card with the reel red, and fades one that cannot save', () => {
    for (const { colors } of Object.values(themes)) {
      const outline = getThemedSaveHeartIconProps({ isSaved: false, colors });
      expect(getThemedSaveHeartIconProps({ isSaved: true, colors })).toEqual({ color: SAVE_HEART_COLOR, fill: SAVE_HEART_COLOR });
      expect(getThemedSaveHeartIconProps({ isSaved: false, enabled: false, colors })).toEqual({
        color: hexWithAlpha(outline.color, appTheme.opacity.disabled),
        fill: 'transparent',
      });
    }
  });

  it('keeps non-toggleable saved status rail actions visually active', () => {
    expect(getRailActionOpacity({ disabled: true, showAsActive: true })).toBe(1);
    expect(getRailActionOpacity({ disabled: true })).toBe(0.42);
    expect(getRailActionOpacity({ disabled: false, pressed: true })).toBe(0.72);
  });

  it('uses a crisp icon pop without a separate halo for save feedback', () => {
    const saveSpec = getSaveHeartTapAnimationSpec({ willSave: true });
    expect(saveSpec.pressInScale).toBeLessThan(1);
    expect(saveSpec.peakScale).toBeGreaterThan(1);
    expect(saveSpec.haloPeakOpacity).toBe(0);

    const unsaveSpec = getSaveHeartTapAnimationSpec({ willSave: false });
    expect(unsaveSpec.peakScale).toBeLessThan(saveSpec.peakScale);
    expect(unsaveSpec.haloPeakOpacity).toBe(0);
  });

  it('uses double tap only to save, never to unsave or duplicate a pending save', () => {
    expect(canSaveViewerItemOnDoubleTap({
      canSave: true,
      isSaved: false,
      saveLoading: false,
    })).toBe(true);
    expect(canSaveViewerItemOnDoubleTap({
      canSave: true,
      isSaved: true,
      saveLoading: false,
    })).toBe(false);
    expect(canSaveViewerItemOnDoubleTap({
      canSave: true,
      isSaved: false,
      saveLoading: true,
    })).toBe(false);
    expect(canSaveViewerItemOnDoubleTap({
      canSave: false,
      isSaved: false,
      saveLoading: false,
    })).toBe(false);
  });

  it('uses the longer Instagram-style pop, hold, and shrink timing', () => {
    const standard = getDoubleTapSaveHeartAnimationSpec(false);
    expect(standard.startScale).toBeLessThan(standard.peakScale);
    expect(standard.settleScale).toBeLessThan(standard.restingScale);
    expect(standard.peakScale).toBeGreaterThan(standard.restingScale);
    expect(standard.exitScale).toBeLessThan(standard.startScale);
    expect(
      standard.entryDurationMs
      + standard.settleDurationMs
      + standard.reboundDurationMs
      + standard.holdDurationMs
      + standard.exitDurationMs
    ).toBeLessThanOrEqual(1200);

    const reduced = getDoubleTapSaveHeartAnimationSpec(true);
    expect(reduced.startScale).toBe(1);
    expect(reduced.peakScale).toBe(1);
    expect(reduced.settleScale).toBe(1);
    expect(reduced.restingScale).toBe(1);
    expect(reduced.exitScale).toBe(1);
    expect(reduced.entryDurationMs).toBe(0);
  });

  it('cycles through the pink and orange Instagram heart treatments', () => {
    expect(getDoubleTapSaveHeartPalette(0)).toEqual({
      startColor: '#ff2d8d',
      endColor: '#ff2d8d',
    });
    expect(getDoubleTapSaveHeartPalette(1)).toEqual({
      startColor: '#ff5a24',
      endColor: '#ffb000',
    });
    expect(getDoubleTapSaveHeartPalette(2)).toEqual(
      getDoubleTapSaveHeartPalette(0)
    );
  });

  it('anchors the large heart at the finger while keeping it fully on screen', () => {
    expect(getDoubleTapSaveHeartPosition({
      x: 190,
      y: 420,
      width: 390,
      height: 844,
      heartSize: 90,
    })).toEqual({ x: 190, y: 420 });

    expect(getDoubleTapSaveHeartPosition({
      x: 4,
      y: 840,
      width: 390,
      height: 844,
      heartSize: 90,
    })).toEqual({ x: 45, y: 799 });
  });

  it('prefers server remix redirect metadata for native create navigation', () => {
    expect(getNativeRemixCreateHref({
      redirectTo: '/create-video?remix=gen-1&remixPost=post-1',
      recreateTool: 'image',
      prompt: 'Fallback prompt',
      context: null,
    })).toBe('/create/video?remix=gen-1&remixPost=post-1');

    expect(getNativeRemixCreateHref({
      redirectTo: 'https://magicbooklet.test/create-motion?remix=gen-2',
      recreateTool: 'image',
      context: null,
    })).toBe('/create/motion?remix=gen-2');
  });

  it.each(['image', 'video', 'motion'] as const)('preserves the owner generation when recreating %s, even without a prompt', (tool) => {
    const href = getNativeRemixCreateHref({
      generationId: 'owner-generation',
      recreateTool: tool,
      prompt: '',
      context: { postId: 'published-post', title: 'My creation', creatorLabel: '@creator' },
    });
    const url = new URL(href!, 'https://magicbooklet.test');
    expect(url.pathname).toBe(`/create/${tool}`);
    expect(url.searchParams.get('remix')).toBe('owner-generation');
    expect(url.searchParams.get('remixPost')).toBe('published-post');
  });

  it('falls back to prompt-only native create navigation when remix metadata is unavailable', () => {
    expect(getNativeRemixCreateHref({
      redirectTo: '/create-image?post=post-1',
      recreateTool: 'image',
      prompt: 'A glossy product photo',
      context: null,
    })).toBe('/create/image?prompt=A%20glossy%20product%20photo');

    expect(getNativeRemixCreateHref({
      recreateTool: 'video',
      prompt: '',
      context: null,
    })).toBeNull();
  });
});


describe('viewer share source surface', () => {
  // Every mobile share used to report 'detail-page' regardless of origin, so
  // three distinct surfaces were indistinguishable from each other and from
  // genuine web detail-page shares.
  it.each([
    ['showcase-feed', 'showcase-reel'],
    ['home-community', 'feed'],
    ['creator-profile', 'creator-profile'],
    ['profile-saved', 'my-creations'],
    ['profile-posts', 'my-creations'],
    ['profile-creations', 'my-creations'],
    ['studio-creations', 'my-creations'],
    ['home-creations', 'my-creations'],
  ] as [PreviewViewerSource, string][])('maps %s to %s', (source, expected) => {
    expect(getViewerShareSourceSurface(source)).toBe(expected);
  });
});

describe('share url', () => {
  it('marks the link with its origin surface so an arriving visit is attributable', () => {
    expect(buildShareUrl('https://magicbooklet.com', '/showcase/post-1', 'showcase-reel'))
      .toBe('https://magicbooklet.com/showcase/post-1?s=showcase-reel');
  });

  it('normalises a trailing slash, which call sites used to disagree about', () => {
    expect(buildShareUrl('https://magicbooklet.com/', '/creators/nova', 'creator-profile'))
      .toBe('https://magicbooklet.com/creators/nova?s=creator-profile');
  });
});

describe('viewer share intent', () => {
  it('shares a published post as a link, never as bare text', () => {
    const intent = getViewerShareIntent(
      railItem({ source: 'showcase-feed', sourceType: 'showcase', sharePath: '/showcase/post-1', title: 'Neon skyline' }),
      'https://magicbooklet.com'
    );

    expect(intent).toEqual({
      kind: 'share',
      content: {
        title: 'Neon skyline',
        message: 'Neon skyline\nhttps://magicbooklet.com/showcase/post-1?s=showcase-reel',
        url: 'https://magicbooklet.com/showcase/post-1?s=showcase-reel',
      },
    });
  });

  it('names the surface it is shared from when that is not where the item came from', () => {
    // The post page recorded its share click as detail-page while its link
    // said showcase-reel (or my-creations from Saved and Profile).
    const fromSaved = railItem({ source: 'profile-saved', sourceType: 'showcase', sharePath: '/showcase/post-1', title: 'Neon skyline' });
    const intent = getViewerShareIntent(fromSaved, 'https://magicbooklet.com', 'detail-page');
    expect(intent).toMatchObject({
      kind: 'share',
      content: { url: 'https://magicbooklet.com/showcase/post-1?s=detail-page' },
    });
    // Without one, the reel's source decides, as before.
    expect(getViewerShareIntent(fromSaved, 'https://magicbooklet.com')).toMatchObject({
      content: { url: 'https://magicbooklet.com/showcase/post-1?s=my-creations' },
    });
  });

  it('routes an unpublished creation to publishing instead of sending a linkless message', () => {
    // This used to share `${title}\n${displayText}` with no URL at all -- a blob
    // of text with nothing to click and no way back into the product.
    expect(getViewerShareIntent(
      railItem({ sourceType: 'generation', sharePath: null, generationId: 'gen-9' }),
      'https://magicbooklet.com'
    )).toEqual({ kind: 'publish', generationId: 'gen-9' });
  });

  it('routes a private owned post to a visibility change', () => {
    expect(getViewerShareIntent(
      railItem({ sourceType: 'owner-post', sharePath: null, ownerPostId: 'post-7', visibility: 'private' }),
      'https://magicbooklet.com'
    )).toEqual({ kind: 'make-public', postId: 'post-7' });
  });

  it('reports nothing to do when the item cannot be shared at all', () => {
    expect(getViewerShareIntent(
      railItem({ canShare: false, sharePath: '/showcase/post-1' }),
      'https://magicbooklet.com'
    )).toEqual({ kind: 'unavailable' });
  });

  it('reports nothing to do for a generation with no id to publish', () => {
    expect(getViewerShareIntent(
      railItem({ sourceType: 'generation', sharePath: null, generationId: null }),
      'https://magicbooklet.com'
    )).toEqual({ kind: 'unavailable' });
  });
});

describe("a profile card's action row", () => {
  it('is the rail less Details, which a tap on the card already opens', () => {
    const item = railItem({ canShare: false, availableActions: ['publish', 'recreate', 'archive', 'delete-creation', 'view-details'] });

    expect(getProfileFeedCardSlots(item).map((slot) => slot.id)).toEqual(['publish', 'create']);
  });

  // Share used to be an archived card's only inline action, and it opened the
  // composer for a creation that was archived (audit 01-6).
  it('offers Restore where an archived creation had nothing left to do', () => {
    const slots = getProfileFeedCardSlots(railItem({
      archivedAt: '2026-01-01T00:00:00.000Z',
      canShare: false,
      availableActions: ['restore', 'delete-creation', 'view-details'],
    }));

    expect(slots).toEqual([{ id: 'restore', action: 'restore', label: 'Restore', a11yLabel: 'Restore this creation', tone: 'success' }]);
  });

  it('offers no Restore to a creation moderation removed, nor to an archived post, which keeps its Share', () => {
    expect(getProfileFeedCardSlots(railItem({
      archivedAt: '2026-01-01T00:00:00.000Z',
      moderationRemoved: true,
      canShare: false,
      availableActions: ['delete-creation', 'view-details'],
    }))).toEqual([]);
    expect(getProfileFeedCardSlots(railItem({
      sourceType: 'owner-post',
      archivedAt: '2026-01-01T00:00:00.000Z',
      sharePath: '/showcase/post-1',
      availableActions: ['restore', 'delete-post', 'share', 'view-details'],
    })).map((slot) => slot.id)).toEqual(['share']);
  });

  it('leaves the reel rail as it was: Restore stays in its •••', () => {
    const archived = railItem({
      archivedAt: '2026-01-01T00:00:00.000Z',
      canShare: false,
      availableActions: ['restore', 'delete-creation', 'view-details'],
    });

    expect(getViewerActionSlots(archived).map((slot) => slot.id)).toEqual(['details']);
  });
});

describe('the creation rows this pass adds', () => {
  it('names Delete creation and Open run, and files Delete with the library rows, in red', () => {
    expect(getViewerActionLabel('delete-creation', 'generation')).toBe('Delete creation');
    expect(getViewerActionLabel('open-run', 'generation')).toBe('Open run');
    expect(isDestructiveViewerAction('delete-creation')).toBe(true);
    expect(isDestructiveViewerAction('open-run')).toBe(false);
    expect(getViewerActionGroupLabel('delete-creation')).toBe('Library');
  });

  it("calls a failed run's Recreate Try again, as the web's Failed card does, and nobody else's", () => {
    expect(getViewerItemActionLabel('recreate', railItem({ runStatus: 'failed' }))).toBe('Try again');
    expect(getViewerItemActionLabel('recreate', railItem({ runStatus: 'succeeded' }))).toBe('Recreate');
    expect(getViewerItemActionLabel('recreate', railItem({ sourceType: 'showcase', runStatus: 'failed' }))).toBe('Remix');
  });

  it('asks before a delete, and says what becomes of a post made from the creation', () => {
    expect(getDeleteCreationConfirmation({ linkedPostId: null })).toEqual({
      title: 'Delete this creation?',
      message: 'This can’t be undone.',
      confirmLabel: 'Delete',
    });
    expect(getDeleteCreationConfirmation({ linkedPostId: 'post-1' }).message)
      .toBe('This can’t be undone. Its post stays up, but remixes based on this creation may stop working.');
  });
});

describe("a remix source's thumbnail", () => {
  const cover = (mediaKind: 'image' | 'video', previewUrl: string | null) => ({
    id: 'cover', url: `https://cdn.test/original.${mediaKind === 'video' ? 'mp4' : 'png'}`, mediaKind,
    previewUrl, contentType: null, originalName: null, width: null, height: null, durationSeconds: null, sortOrder: 0,
  });

  // It was the full-size original, drawn 40pt across (audit 01, below the cut).
  it('is the poster, for a picture and for a video', () => {
    expect(getRemixSourceThumbnailUrl(railItem({ mediaItems: [cover('image', 'https://cdn.test/poster.webp')] })))
      .toBe('https://cdn.test/poster.webp');
    expect(getRemixSourceThumbnailUrl(railItem({ mediaKind: 'video', mediaItems: [cover('video', 'https://cdn.test/frame.webp')] })))
      .toBe('https://cdn.test/frame.webp');
  });

  it('is never a video file', () => {
    expect(getRemixSourceThumbnailUrl(railItem({
      mediaKind: 'video',
      mediaUrl: 'https://cdn.test/original.mp4',
      mediaItems: [cover('video', null)],
    }))).toBeNull();
  });

  // A picture without a poster drew its original instead: 1.2 MB on average, up to
  // about 8 MB, for 40pt (2026-11-01 review). The row has no picture until a poster exists.
  it('is no picture for an image that has no poster, never its full-size original', () => {
    expect(getRemixSourceThumbnailUrl(railItem({ mediaUrl: 'https://cdn.test/original.png', mediaItems: [cover('image', null)] })))
      .toBeNull();
    expect(getRemixSourceThumbnailUrl(railItem({ mediaUrl: 'https://cdn.test/original.png', mediaItems: [] }))).toBeNull();
  });
});

describe("a remix source's title", () => {
  const titleOf = (overrides: Partial<ImmersivePreviewItem>) => getRemixSourceContext(railItem(overrides)).title;

  it("is the post's own title", () => {
    expect(titleOf({ title: 'Kung fu cats', recreatePrompt: 'Two cats sparring on a rooftop' })).toBe('Kung fu cats');
  });

  // The server names a post nobody named "Untitled Creation" (src/lib/showcase-feed.ts),
  // and the row said so where the post's Home card shows its prompt.
  it.each(['Untitled Creation', 'Untitled Note', 'Untitled post', 'Community post'])(
    'is the prompt in place of "%s", as the Home card reads it',
    (title) => {
      expect(titleOf({ title, recreatePrompt: 'Two cats sparring on a rooftop' })).toBe('Two cats sparring on a rooftop');
    },
  );

  it('names the kind of creation when the post has no words of its own', () => {
    expect(titleOf({ title: 'Untitled Creation', recreatePrompt: 'Untitled Creation', recreateTool: 'image' })).toBe('Image creation');
    expect(titleOf({ title: 'Untitled Creation', recreatePrompt: '', recreateTool: 'video' })).toBe('Video creation');
    expect(titleOf({ title: '', recreatePrompt: '  ', recreateTool: 'motion' })).toBe('Motion creation');
    expect(titleOf({ title: 'Untitled Note', recreatePrompt: '', previewKind: 'text' })).toBe('Creator note');
  });
});
