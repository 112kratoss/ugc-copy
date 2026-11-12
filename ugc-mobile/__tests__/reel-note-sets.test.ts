import { describe, expect, it } from 'vitest';

import { clubReelNotes, frontNoteOfSet, noteIndexAtOffset, type ReelPage } from '../lib/reel-note-sets';

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

  it('never moves a page the reader has passed when a later page of the lane arrives', () => {
    const first = [media('m1'), note('n1'), media('m2'), media('m3')];
    const more = [...first, note('n2'), media('m4')];
    const before = clubReelNotes(first, { isNote });
    const after = clubReelNotes(more, { isNote });
    expect(shape(before)).toBe('m1 | [n1] | m2 | m3');
    // The set gains a card; every page keeps its place.
    expect(shape(after)).toBe('m1 | [n1 n2] | m2 | m3 | m4');
  });
});

describe('frontNoteOfSet', () => {
  const set = { key: 'n1', notes: [note('n1'), note('n2'), note('n3')] };

  it('is the card the reader left the set on', () => {
    expect(frontNoteOfSet(set, 'n3').id).toBe('n3');
  });

  it('is the first card for a set not yet swiped, or once that card has gone', () => {
    expect(frontNoteOfSet(set, null).id).toBe('n1');
    expect(frontNoteOfSet(set, 'removed').id).toBe('n1');
  });
});

describe('noteIndexAtOffset', () => {
  it('reads the settled card from the scroll offset', () => {
    expect(noteIndexAtOffset(0, 300, 3)).toBe(0);
    expect(noteIndexAtOffset(310, 300, 3)).toBe(1);
    expect(noteIndexAtOffset(590, 300, 3)).toBe(2);
  });

  it('stays inside the set through an overscroll at either end', () => {
    expect(noteIndexAtOffset(-40, 300, 3)).toBe(0);
    expect(noteIndexAtOffset(900, 300, 3)).toBe(2);
    expect(noteIndexAtOffset(100, 0, 3)).toBe(0);
  });
});
