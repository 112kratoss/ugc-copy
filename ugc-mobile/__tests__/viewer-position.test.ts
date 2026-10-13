import { describe, expect, it } from 'vitest';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import { isRemovedFromViewer, removeViewerSessionItems } from '../lib/viewer-session-items';
import {
  changeViewerPage,
  initialViewerPosition,
  isDetailsPageCovering,
  pickViewerItemAfterRemoval,
  resolveViewerPosition,
  settleViewerItem,
} from '../lib/viewer-position';

function post(id: string) {
  return { id, previewKind: 'media', mediaItems: [{ id: `${id}-1` }, { id: `${id}-2` }], details: { title: id }, availableActions: ['view-details'] } as unknown as ImmersivePreviewItem;
}

describe('viewer navigation ownership', () => {
  it('opens Read more on Details while remembering the first media page for Back', () => {
    const item = post('one');
    const position = resolveViewerPosition([item], null, 'one', 'details')!;
    expect(position).toEqual({ itemId: 'one', pageKey: 'details', mediaPageKey: 'media:one-1' });
    const back = changeViewerPage(position, item.id, position.mediaPageKey);
    expect(resolveViewerPosition([item], back, 'one', 'details')).toEqual(back);
    expect(settleViewerItem(position, post('two')).pageKey).toBe('media:two-1');
  });

  it('ignores the initial Details request for another post or a post without Details', () => {
    expect(resolveViewerPosition([post('two')], null, 'one', 'details')?.pageKey).toBe('media:two-1');
    const item = { ...post('one'), details: undefined, availableActions: [] };
    expect(resolveViewerPosition([item], null, 'one', 'details')?.pageKey).toBe('media:one-1');
  });

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

describe('where the reel goes when posts leave it', () => {
  function byCreator(id: string, creatorId: string) {
    return { ...post(id), showcasePostId: id, creatorId } as ImmersivePreviewItem;
  }
  const reel = [byCreator('a', 'maya'), byCreator('b', 'luna'), byCreator('c', 'luna'), byCreator('d', 'nova')];
  const ids = (items: ImmersivePreviewItem[]) => items.map((item) => item.id);

  /** What the reel does: pick from the list as it was, then remove, then resolve. */
  function dismiss(items: ImmersivePreviewItem[], activeIndex: number, target: { postId?: string; creatorId?: string }, initialId: string) {
    const next = pickViewerItemAfterRemoval(items, activeIndex, (item) => isRemovedFromViewer(item, target));
    const remaining = removeViewerSessionItems(items, target);
    return resolveViewerPosition(remaining, next ? initialViewerPosition(next) : null, initialId)?.itemId ?? null;
  }

  it('lands on the next post, not the one the reel was opened on or the top', () => {
    // Not interested on the post the reel opened on, the common case: the old
    // `Math.min(current, remaining - 1)`, read against the list from before the
    // removal, kept the dismissed post; the position then fell back to the
    // opened post's id, gone too, and so to the first post of the feed ('a').
    expect(dismiss(reel, 2, { postId: 'c' }, 'c')).toBe('d');
    // On any other post it fell back to the post the reel was opened on ('a').
    expect(dismiss(reel, 2, { postId: 'c' }, 'a')).toBe('d');
    expect(dismiss(reel, 0, { postId: 'a' }, 'a')).toBe('b');
  });

  it("skips the hidden creator's other posts", () => {
    expect(dismiss(reel, 1, { creatorId: 'luna' }, 'a')).toBe('d');
    expect(pickViewerItemAfterRemoval(reel, 1, (item) => item.creatorId === 'luna')?.id).toBe('d');
  });

  it('steps back to the nearest post before it when nothing after it stays', () => {
    expect(dismiss(reel, 3, { postId: 'd' }, 'a')).toBe('c');
    expect(pickViewerItemAfterRemoval(reel, 3, (item) => item.creatorId !== 'maya')?.id).toBe('a');
  });

  it('stays on the post on screen when the removal spares it, and finds nothing when nothing stays', () => {
    expect(pickViewerItemAfterRemoval(reel, 2, (item) => item.id === 'a')?.id).toBe('c');
    expect(pickViewerItemAfterRemoval(reel, 1, () => true)).toBeNull();
    expect(pickViewerItemAfterRemoval([], 0, () => true)).toBeNull();
    expect(ids(removeViewerSessionItems(reel, { creatorId: 'luna' }))).toEqual(['a', 'd']);
  });
});
