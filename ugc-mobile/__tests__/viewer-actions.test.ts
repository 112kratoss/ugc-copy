import { describe, expect, it } from 'vitest';

import {
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
  isDestructiveViewerAction,
} from '../lib/viewer-actions';

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
