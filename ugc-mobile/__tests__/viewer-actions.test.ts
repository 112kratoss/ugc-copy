import { describe, expect, it } from 'vitest';

import { getViewerActionGroupLabel, getViewerActionLabel, isDestructiveViewerAction } from '../lib/viewer-actions';

describe('immersive viewer actions', () => {
  it('uses clear source-aware labels for owner and creation commands', () => {
    expect(getViewerActionLabel('publish')).toBe('Post this creation');
    expect(getViewerActionLabel('edit-post')).toBe('Edit post');
    expect(getViewerActionLabel('view-linked')).toBe('View linked post');
    expect(getViewerActionLabel('view-details')).toBe('View details');
  });

  it('marks only removal-style commands as destructive', () => {
    expect(isDestructiveViewerAction('unsave')).toBe(true);
    expect(isDestructiveViewerAction('archive')).toBe(true);
    expect(isDestructiveViewerAction('restore')).toBe(false);
    expect(isDestructiveViewerAction('share')).toBe(false);
  });

  it('groups creation-to-post actions separately from general media actions', () => {
    expect(getViewerActionGroupLabel('publish')).toBe('Creation to post');
    expect(getViewerActionGroupLabel('view-linked')).toBe('Creation to post');
    expect(getViewerActionGroupLabel('edit-linked')).toBe('Creation to post');
    expect(getViewerActionGroupLabel('archive')).toBe('Library');
    expect(getViewerActionGroupLabel('share')).toBe('Media actions');
  });
});
