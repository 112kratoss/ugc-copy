import { describe, expect, it } from 'vitest';

import {
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
      color: '#fb7185',
      fill: '#fb7185',
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

  it('uses a restrained heart tap animation for save feedback', () => {
    const saveSpec = getSaveHeartTapAnimationSpec({ willSave: true });
    expect(saveSpec.pressInScale).toBe(0.96);
    expect(saveSpec.peakScale).toBe(1.04);
    expect(saveSpec.haloPeakScale).toBe(1.14);
    expect(saveSpec.haloPeakOpacity).toBeLessThanOrEqual(0.14);

    const unsaveSpec = getSaveHeartTapAnimationSpec({ willSave: false });
    expect(unsaveSpec.peakScale).toBeLessThan(saveSpec.peakScale);
    expect(unsaveSpec.haloPeakOpacity).toBeLessThan(saveSpec.haloPeakOpacity);
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
