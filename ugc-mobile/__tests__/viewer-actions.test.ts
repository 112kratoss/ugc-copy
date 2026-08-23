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
  getViewerActionGroupLabel,
  getViewerActionLabel,
  getViewerActionSlots,
  getViewerShareIntent,
  getViewerShareSourceSurface,
  getViewerStateChip,
  isDestructiveViewerAction,
} from '../lib/viewer-actions';
import type { ImmersivePreviewItem, PreviewViewerSource } from '../lib/immersive-preview-view-model';

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
      label: 'Unlock',
      a11yLabel: 'Add an unlock bundle',
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

  it('marks only removal-style commands as destructive', () => {
    expect(isDestructiveViewerAction('unsave')).toBe(true);
    expect(isDestructiveViewerAction('save')).toBe(false);
    expect(isDestructiveViewerAction('archive')).toBe(true);
    expect(isDestructiveViewerAction('delete-post')).toBe(true);
    expect(isDestructiveViewerAction('restore')).toBe(false);
    expect(isDestructiveViewerAction('share')).toBe(false);
  });

  it('groups creation-to-post actions separately from general media actions', () => {
    expect(getViewerActionGroupLabel('publish')).toBe('Creation to post');
    expect(getViewerActionGroupLabel('view-linked')).toBe('Creation to post');
    expect(getViewerActionGroupLabel('edit-linked')).toBe('Creation to post');
    expect(getViewerActionGroupLabel('change-linked-visibility')).toBe('Creation to post');
    expect(getViewerActionGroupLabel('edit-post')).toBe('Your post');
    expect(getViewerActionGroupLabel('change-visibility')).toBe('Your post');
    expect(getViewerActionGroupLabel('archive')).toBe('Library');
    expect(getViewerActionGroupLabel('delete-post')).toBe('Library');
    expect(getViewerActionGroupLabel('share')).toBe('Media actions');
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
    })).toBe('/create/video?remix=gen-1&remixPost=post-1');

    expect(getNativeRemixCreateHref({
      redirectTo: 'https://magicbooklet.test/create-motion?remix=gen-2',
      recreateTool: 'image',
    })).toBe('/create/motion?remix=gen-2');
  });

  it('falls back to prompt-only native create navigation when remix metadata is unavailable', () => {
    expect(getNativeRemixCreateHref({
      redirectTo: '/create-image?post=post-1',
      recreateTool: 'image',
      prompt: 'A glossy product photo',
    })).toBe('/create/image?prompt=A%20glossy%20product%20photo');

    expect(getNativeRemixCreateHref({
      recreateTool: 'video',
      prompt: '',
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
