import { describe, expect, it } from 'vitest';

import {
  buildImmersiveGenerationItems,
  getImmersiveStatusSlide,
  isImmersiveSelectionMissing,
  type ImmersivePreviewItem,
} from '../lib/immersive-preview-view-model';
import { buildImmersiveSlidePages } from '../lib/immersive-slide-pages';

describe('an unavailable creation in the viewers', () => {
  const [item] = buildImmersiveGenerationItems('profile-creations', [{
    id: 'dress-change',
    output_url: null,
    media: null,
    status: 'succeeded',
    created_at: '2026-09-02T10:00:00.000Z',
    model: 'kling-2.6/motion-control',
    category: 'image',
    prompt: 'Change the dress',
    source_unavailable_at: '2026-09-08T06:15:00.000Z',
  }], { creatorLabel: '@owner' });

  it('opens on a status page that says its file is gone', () => {
    expect(item.availability).toBe('source-unavailable');
    expect(buildImmersiveSlidePages(item)[0]).toEqual({ type: 'status' });
    expect(getImmersiveStatusSlide(item).title).toBe('This file is no longer available');
  });

  it('offers nothing that needs the missing file', () => {
    expect(item.mediaItems).toEqual([]);
    expect(item.canShare).toBe(false);
    expect(item.availableActions).not.toContain('publish');
    expect(item.availableActions).not.toContain('share');
  });
});

describe('isImmersiveSelectionMissing', () => {
  const items = [{ id: 'first' }, { id: 'second' }] as ImmersivePreviewItem[];

  it('reports a named item that did not load', () => {
    expect(isImmersiveSelectionMissing(items, 'second')).toBe(false);
    expect(isImmersiveSelectionMissing(items, 'deleted')).toBe(true);
  });

  it('has nothing to report for an open that named no item', () => {
    expect(isImmersiveSelectionMissing(items, '')).toBe(false);
    expect(isImmersiveSelectionMissing(items, null)).toBe(false);
  });
});
