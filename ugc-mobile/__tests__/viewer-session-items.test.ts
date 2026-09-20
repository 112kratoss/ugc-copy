import { describe, expect, it } from 'vitest';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import { reconcileViewerSessionItems } from '../lib/viewer-session-items';

const post = (id: string, title = id) => ({ id, title, source: 'showcase-feed' } as ImmersivePreviewItem);
const ids = (items: ImmersivePreviewItem[]) => items.map((item) => item.id);

describe('viewer session order', () => {
  it('keeps the opened video at its native offset when a stale snapshot refetches in a different order', () => {
    const cached = [post('a'), post('selected-video'), post('unrelated-image')];
    const refreshedVideo = post('selected-video', 'Fresh title and media');
    const fresh = [post('new-post'), post('unrelated-image'), post('a'), refreshedVideo];
    const items = reconcileViewerSessionItems(cached, fresh);

    expect(ids(items)).toEqual(['a', 'selected-video', 'unrelated-image', 'new-post']);
    expect(items[1]).toBe(refreshedVideo);
    // Another refresh while browsing must not move the mounted player either.
    expect(ids(reconcileViewerSessionItems(items, [...fresh].reverse()))).toEqual(ids(items));
  });

  it('uses the current source order for a new opening or an initially empty loader', () => {
    const fresh = [post('b'), post('a')];
    expect(ids(reconcileViewerSessionItems([], fresh))).toEqual(['b', 'a']);
  });

  it('removes missing posts, refreshes retained objects, and appends new pages once', () => {
    const retained = post('b', 'Updated');
    const items = reconcileViewerSessionItems([post('a'), post('b')], [post('c'), retained, post('d')]);
    expect(ids(items)).toEqual(['b', 'c', 'd']);
    expect(items[0]).toBe(retained);
    expect(reconcileViewerSessionItems(items, [])).toEqual([]);
  });
});
