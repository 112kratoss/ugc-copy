import { describe, expect, it } from 'vitest';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import { changeViewerPage, isDetailsPageCovering, resolveViewerPosition, settleViewerItem } from '../lib/viewer-position';

function post(id: string) {
  return { id, previewKind: 'media', mediaItems: [{ id: `${id}-1` }, { id: `${id}-2` }], details: { title: id }, availableActions: ['view-details'] } as unknown as ImmersivePreviewItem;
}

describe('viewer navigation ownership', () => {
  it('keeps Details through ten editor returns and unchanged vertical settles', () => {
    const items = [post('one'), post('two')];
    let position = resolveViewerPosition(items, null, 'one')!;
    position = changeViewerPage(position, 'one', 'media:one-2');
    position = changeViewerPage(position, 'one', 'details');
    for (let cycle = 0; cycle < 10; cycle++) {
      position = settleViewerItem(position, items[0]);
      position = resolveViewerPosition(items.map((item) => ({ ...item })), position, 'one')!;
      expect(position.pageKey).toBe('details');
      expect(position.mediaPageKey).toBe('media:one-2');
    }
    expect(changeViewerPage(position, 'one', position.mediaPageKey).pageKey).toBe('media:one-2');
  });

  it('ignores late events from an inactive neighbor', () => {
    const position = changeViewerPage(resolveViewerPosition([post('one')], null, 'one')!, 'one', 'details');
    expect(changeViewerPage(position, 'two', 'media:two-1')).toBe(position);
  });

  it('preserves post and page identity when refresh reorders the feed and media', () => {
    const one = post('one');
    const position = changeViewerPage(resolveViewerPosition([one], null, 'one')!, 'one', 'media:one-2');
    expect(resolveViewerPosition([post('two'), { ...one, mediaItems: [...one.mediaItems!].reverse() }], position, 'one')).toEqual(position);
  });

  it('starts another post on its media and recovers when the active post disappears', () => {
    const position = changeViewerPage(resolveViewerPosition([post('one')], null, 'one')!, 'one', 'details');
    expect(settleViewerItem(position, post('two')).pageKey).toBe('media:two-1');
    expect(resolveViewerPosition([post('two')], position, 'one')?.itemId).toBe('two');
    expect(resolveViewerPosition([], position, 'one')).toBeNull();
  });

  it('only calls the details page an overlay while it covers another page', () => {
    const one = post('one');
    const openDetails = changeViewerPage(resolveViewerPosition([one], null, 'one')!, 'one', 'details');
    expect(isDetailsPageCovering(one, openDetails)).toBe(true);
    expect(isDetailsPageCovering(one, resolveViewerPosition([one], null, 'one'))).toBe(false);
    // The neighbour's details page is not this slide's overlay.
    expect(isDetailsPageCovering(post('two'), openDetails)).toBe(false);

    // A creation with no media still has its status page underneath, so its
    // details page is a real overlay and the reel may freeze behind it.
    const failedRun = { ...one, mediaItems: [], previewKind: undefined } as unknown as ImmersivePreviewItem;
    expect(isDetailsPageCovering(failedRun, { itemId: 'one', pageKey: 'details', mediaPageKey: 'status' })).toBe(true);
  });
});
