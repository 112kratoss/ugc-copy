import { describe, expect, it } from 'vitest';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import { isRemovedFromViewer, reconcileViewerSessionItems, removeViewerSessionItems } from '../lib/viewer-session-items';

const post = (id: string, title = id, creatorId = `creator-${id}`) => (
  { id, title, source: 'showcase-feed', showcasePostId: id, creatorId } as ImmersivePreviewItem
);
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

  it("keeps the reader's post on its row when the refresh leaves out posts above it", () => {
    // A link opened Saree from Home's cached For you (row 9 of 11); the reel's
    // refetch read a new page without Fox, His Majesty and Peeling. Dropping
    // them moved Saree to row 6, and Android drew row 9 (NEELAKURINJI, newly
    // appended) at the old offset until the alignment scroll (Pixel_9a, 2026-11-25).
    const cached = ['fox', 'female', 'minnal', 'venom', 'mahabali', 'majesty', 'peeling', 'founder', 'intense', 'saree', 'robot']
      .map((id) => post(id));
    const refreshedSaree = post('saree', 'Fresh copy');
    const page = [refreshedSaree, post('chai'), post('female'), post('minnal'), post('venom'), post('mahabali'),
      post('neelakurinji'), post('founder'), post('munnar'), post('intense'), post('robot')];
    const items = reconcileViewerSessionItems(cached, page, { anchorId: 'saree' });

    expect(items.findIndex((item) => item.id === 'saree')).toBe(9);
    expect(items[9]).toBe(refreshedSaree);
    expect(ids(items)).toEqual([...ids(cached), 'chai', 'neelakurinji', 'munnar']);
    // Below the reader, a post the refresh left out still goes: nothing above them moves.
    expect(ids(reconcileViewerSessionItems(items, page.filter((item) => item.id !== 'robot'), { anchorId: 'saree' })))
      .toEqual([...ids(cached).slice(0, 10), 'chai', 'neelakurinji', 'munnar']);
    // With no reader's post in the list, the refresh's own answer stands, as before.
    expect(ids(reconcileViewerSessionItems(cached, page, { anchorId: 'gone' })))
      .toEqual(ids(reconcileViewerSessionItems(cached, page)));
  });

  it("keeps a lane's posts in place when its refresh is a new session that leaves them out", () => {
    // The reader is on 'b'. A lane refresh ranks what they have seen last, so
    // the new pages hold none of it; dropping those posts moved the reader.
    const seen = [post('a'), post('b'), post('c')];
    const refreshedC = post('c', 'Fresh copy');
    const items = reconcileViewerSessionItems(seen, [post('x'), refreshedC, post('y')], { keepMissing: true });
    expect(ids(items)).toEqual(['a', 'b', 'c', 'x', 'y']);
    expect(items[2]).toBe(refreshedC);
    // A lane that let its first pages go (a windowed Recent lane) keeps them too.
    expect(ids(reconcileViewerSessionItems(items, [post('y'), post('z')], { keepMissing: true })))
      .toEqual(['a', 'b', 'c', 'x', 'y', 'z']);
  });

  it('takes out what the reader removed: the post, or every post by a hidden creator', () => {
    const items = [post('a', 'a', 'maya'), post('b', 'b', 'luna'), post('c', 'c', 'maya'), post('d', 'd', 'nova')];
    expect(ids(removeViewerSessionItems(items, { postId: 'b' }))).toEqual(['a', 'c', 'd']);
    expect(ids(removeViewerSessionItems(items, { creatorId: 'maya' }))).toEqual(['b', 'd']);
    expect(isRemovedFromViewer(items[3], { postId: 'b' })).toBe(false);
    expect(isRemovedFromViewer(items[3], {})).toBe(false);
  });
});
