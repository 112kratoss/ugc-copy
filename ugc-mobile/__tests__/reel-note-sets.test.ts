import { describe, expect, it } from 'vitest';

import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import {
  buildReelList,
  closeReachedNoteSets,
  clubReelNotes,
  frontNoteOfSet,
  isRestingOnNote,
  noteIndexAtOffset,
  type ReelListItem,
  type ReelPage,
} from '../lib/reel-note-sets';
import { resolveViewerPosition } from '../lib/viewer-position';

interface Post { id: string; note: boolean }

const media = (id: string): Post => ({ id, note: false });
const note = (id: string): Post => ({ id, note: true });
const isNote = (post: Post) => post.note;

/** "m1 | [n1 n2] | m2": a page per entry, a set in brackets. */
function shape(pages: ReelPage<Post>[]) {
  return pages
    .map((page) => (page.kind === 'post' ? page.item.id : `[${page.set.notes.map((entry) => entry.id).join(' ')}]`))
    .join(' | ');
}

describe('clubReelNotes', () => {
  it('leaves a lane of pictures and videos as it is', () => {
    expect(shape(clubReelNotes([media('m1'), media('m2')], { isNote }))).toBe('m1 | m2');
  });

  it('gathers the notes near each other into one page, where the first stood', () => {
    // The owner's For You lane on 2026-11-12: a note, four posts, then two more notes.
    const lane = [media('m1'), note('n1'), media('m2'), media('m3'), media('m4'), media('m5'), note('n2'), note('n3'), media('m6')];
    expect(shape(clubReelNotes(lane, { isNote }))).toBe('m1 | [n1 n2 n3] | m2 | m3 | m4 | m5 | m6');
  });

  it('gives a lone note the page, with one card', () => {
    const pages = clubReelNotes([media('m1'), note('n1'), media('m2')], { isNote });
    expect(shape(pages)).toBe('m1 | [n1] | m2');
    expect(pages[1]).toEqual({ kind: 'notes', set: { key: 'n1', notes: [note('n1')] } });
  });

  it('takes five notes at most; the sixth starts the next set where it stands', () => {
    const lane = [note('n1'), note('n2'), note('n3'), note('n4'), note('n5'), note('n6'), media('m1'), note('n7')];
    expect(shape(clubReelNotes(lane, { isNote }))).toBe('[n1 n2 n3 n4 n5] | [n6 n7] | m1');
  });

  it('pulls in only the notes within the next ten posts, so none jumps far up the lane', () => {
    const far = Array.from({ length: 10 }, (_, index) => media(`m${index + 1}`));
    const lane = [note('n1'), ...far, note('n2')];
    expect(shape(clubReelNotes(lane, { isNote }))).toBe(`[n1] | ${far.map((post) => post.id).join(' | ')} | [n2]`);
    // One post nearer and it joins.
    const near = [note('n1'), ...far.slice(1), note('n2')];
    expect(shape(clubReelNotes(near, { isNote }))).toBe(`[n1 n2] | ${far.slice(1).map((post) => post.id).join(' | ')}`);
  });

  it('starts a set at the post the reel was opened on, so it is the card in front', () => {
    const lane = [note('n1'), media('m1'), note('n2'), note('n3')];
    expect(shape(clubReelNotes(lane, { isNote, anchorId: 'n2' }))).toBe('[n1] | m1 | [n2 n3]');
  });

  // Review of #774: a note from the lane's next page joined the set at index
  // 12 while the reader stood at 17, and was never given a page ahead.
  it('gives a note that arrives later a page ahead, once the reader has reached the set near it', () => {
    const first = [media('m1'), note('n1'), media('m2'), media('m3')];
    const more = [...first, note('n2'), media('m4')];
    expect(shape(clubReelNotes(first, { isNote }))).toBe('m1 | [n1] | m2 | m3');
    // The reader has passed n1's page: it is closed, and n2 stands where the lane put it.
    expect(shape(clubReelNotes(more, { isNote, closedGroups: new Map([['n1', 'n1']]) }))).toBe('m1 | [n1] | m2 | m3 | [n2] | m4');
    // A set still ahead of the reader takes it in.
    expect(shape(clubReelNotes(more, { isNote }))).toBe('m1 | [n1 n2] | m2 | m3 | m4');
  });

  it('keeps a closed set together when its first note leaves, and still lets no newcomer in', () => {
    const lane = [note('n2'), note('n3'), media('m1'), note('n4')];
    const closedGroups = new Map([['n1', 'n1'], ['n2', 'n1'], ['n3', 'n1']]);
    expect(shape(clubReelNotes(lane, { isNote, closedGroups }))).toBe('[n2 n3] | m1 | [n4]');
  });

  it('never merges two sets the reader has passed, however near a removal brings them', () => {
    const lane = [note('n1'), media('m1'), note('n2')];
    const closedGroups = new Map([['n1', 'n1'], ['n2', 'n2']]);
    expect(shape(clubReelNotes(lane, { isNote, closedGroups }))).toBe('[n1] | m1 | [n2]');
  });

  it('keeps a note a page of its own when the reel was opened on its Details page', () => {
    const lane = [note('n1'), note('n2'), media('m1'), note('n3')];
    expect(shape(clubReelNotes(lane, { isNote, anchorId: 'n2', soloId: 'n2' }))).toBe('[n1 n3] | n2 | m1');
  });
});

describe('frontNoteOfSet', () => {
  const set = { key: 'n1', notes: [note('n1'), note('n2'), note('n3')] };

  it('is the reel\'s current post when that is one of the set\'s', () => {
    expect(frontNoteOfSet(set, { currentId: 'n3', rememberedId: 'n2' }).id).toBe('n3');
  });

  it('is the card the reader left the set on while they are elsewhere', () => {
    expect(frontNoteOfSet(set, { currentId: 'm9', rememberedId: 'n2' }).id).toBe('n2');
  });

  it('is the first card for a set not yet swiped, or once that card has gone', () => {
    expect(frontNoteOfSet(set, {}).id).toBe('n1');
    expect(frontNoteOfSet(set, { rememberedId: 'removed' }).id).toBe('n1');
  });
});

describe('the scroll position of a row of cards', () => {
  it('reads the card from the scroll offset', () => {
    expect(noteIndexAtOffset(0, 300, 3)).toBe(0);
    expect(noteIndexAtOffset(310, 300, 3)).toBe(1);
    expect(noteIndexAtOffset(590, 300, 3)).toBe(2);
  });

  it('stays inside the set through an overscroll at either end', () => {
    expect(noteIndexAtOffset(-40, 300, 3)).toBe(0);
    expect(noteIndexAtOffset(900, 300, 3)).toBe(2);
    expect(noteIndexAtOffset(100, 0, 3)).toBe(0);
  });

  it('knows a row at rest on a card from one passing between two', () => {
    expect(isRestingOnNote(600, 300)).toBe(true);
    expect(isRestingOnNote(600.4, 300)).toBe(true);
    expect(isRestingOnNote(450, 300)).toBe(false);
  });
});

// Review of #774, finding 10: the three faults below all passed a suite that
// tested the clubbing and the reel's position apart. These run the list the
// reel renders through the position logic it is read with.
describe('the reel\'s list of pages, read by its position', () => {
  const picture = (id: string) => ({ id, mediaItems: [{ id: `${id}-1` }], details: { title: id }, availableActions: ['view-details'] }) as unknown as ImmersivePreviewItem;
  const writing = (id: string) => ({ id, previewKind: 'text', mediaItems: [], details: { title: id }, availableActions: ['view-details'] }) as unknown as ImmersivePreviewItem;
  const isWriting = (item: ImmersivePreviewItem) => item.previewKind === 'text';
  const ids = (list: ReelListItem<ImmersivePreviewItem>[]) => list
    .map((entry) => (entry.noteSet ? `${entry.id}[${entry.noteSet.notes.map((member) => member.id).join(' ')}]` : entry.id))
    .join(' | ');

  it('opens a recipe on a note on that note\'s Details page, as a slide of its own', () => {
    // Search → Recipes pushes the reel with initialPage=details. As a page of
    // notes it had no Details to show, and the reel locked on a position
    // that said it was covering one.
    const lane = [picture('m1'), writing('n1'), writing('n2')];
    const list = buildReelList(lane, { isNote: isWriting, anchorId: 'n1', soloId: 'n1' });
    expect(ids(list)).toBe('m1 | n1 | n2[n2]');
    const opened = list.find((entry) => entry.id === 'n1')!;
    expect(opened.noteSet).toBeUndefined();
    expect(resolveViewerPosition(list, null, 'n1', 'details')).toMatchObject({ itemId: 'n1', pageKey: 'details' });
  });

  it('keeps the reader on a note that a removal brings within reach of an earlier set', () => {
    // n1, ten posts, M, then N: Not interested on M lands the reader on N, and
    // without M, N is within n1's window. The position named N, the list held
    // only n1 for that page, and the reel fell back to the post it was opened on.
    const posts = Array.from({ length: 9 }, (_, index) => picture(`m${index + 1}`));
    const before = [writing('n1'), ...posts, picture('M'), writing('N')];
    const after = before.filter((item) => item.id !== 'M');
    const position = resolveViewerPosition(buildReelList(before, { isNote: isWriting, anchorId: 'm1' }), null, 'N')!;
    expect(position.itemId).toBe('N');

    // The reader stood on M, having passed n1's page: that set is closed, and N keeps its own page.
    const onM = closeReachedNoteSets(new Map(), buildReelList(before, { isNote: isWriting, anchorId: 'm1' }), before.length - 2);
    const list = buildReelList(after, { isNote: isWriting, anchorId: 'm1', closedGroups: onM, currentId: 'N' });
    const pages = `n1[n1] | ${posts.map((post) => post.id).join(' | ')} | N[N]`;
    expect(ids(list)).toBe(pages);
    expect(resolveViewerPosition(list, position, 'm1')?.itemId).toBe('N');

    // Landing on N closes its set too, and the two closed sets still do not merge.
    const onN = closeReachedNoteSets(onM, list, list.length - 1);
    expect(ids(buildReelList(after, { isNote: isWriting, anchorId: 'm1', closedGroups: onN, currentId: 'N' }))).toBe(pages);
  });

  it('holds a set by the note the position names, wherever that note sits in it', () => {
    // Even with nothing closed, a note that joins a set as a later card is
    // the card in front while the reel's position is on it.
    const list = buildReelList([writing('n1'), picture('m1'), writing('N')], { isNote: isWriting, anchorId: 'm1', currentId: 'N' });
    expect(ids(list)).toBe('N[n1 N] | m1');
    expect(resolveViewerPosition(list, { itemId: 'N', pageKey: 'text', mediaPageKey: 'text' }, 'm1')?.itemId).toBe('N');
  });

  it('stays on the card in front when a refresh drops the set\'s first note', () => {
    const before = [writing('n1'), writing('n2'), writing('n3'), picture('m1')];
    const frontNoteIds = { n1: 'n3' };
    expect(ids(buildReelList(before, { isNote: isWriting, anchorId: 'm1', frontNoteIds, currentId: 'n3' }))).toBe('n3[n1 n2 n3] | m1');
    // The set is now named by n2, so what was remembered under n1 is gone: the position still finds its card.
    const list = buildReelList(before.slice(1), { isNote: isWriting, anchorId: 'm1', frontNoteIds, currentId: 'n3' });
    expect(ids(list)).toBe('n3[n2 n3] | m1');
    expect(resolveViewerPosition(list, { itemId: 'n3', pageKey: 'text', mediaPageKey: 'text' }, 'm1')?.itemId).toBe('n3');
  });

  it('closes every set up to the reader\'s page, each under its own name, and hands back the same map when nothing is new', () => {
    const list = buildReelList([writing('n1'), writing('n2'), picture('m1'), writing('n3')], { isNote: isWriting, window: 1 });
    expect(ids(list)).toBe('n1[n1 n2] | m1 | n3[n3]');
    const onM1 = closeReachedNoteSets(new Map(), list, 1);
    expect([...onM1]).toEqual([['n1', 'n1'], ['n2', 'n1']]);
    expect(closeReachedNoteSets(onM1, list, 1)).toBe(onM1);
    expect([...closeReachedNoteSets(onM1, list, 2)]).toEqual([['n1', 'n1'], ['n2', 'n1'], ['n3', 'n3']]);
  });
});
