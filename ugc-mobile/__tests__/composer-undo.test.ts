import { describe, expect, it } from 'vitest';

import {
  putBackComposerRemoval,
  takeComposerMadeWithRow,
  takeComposerMedia,
  takeComposerResourceCard,
} from '../lib/composer-undo';
import { MEDIA_MAX_ITEMS } from '../lib/media-reorder';
import {
  createMadeWithRow,
  createPostComposerResourceCard,
  getDefaultPostComposerDraft,
  type PostComposerDraft,
  type PostComposerMediaItem,
} from '../lib/post-new-view-model';

function media(id: string): PostComposerMediaItem {
  return { id, mediaKey: `key-${id}`, uri: `file:///${id}.jpg`, name: `${id}.jpg`, type: 'image/jpeg', mediaKind: 'image' };
}

function mediaPost(): PostComposerDraft {
  const draft = getDefaultPostComposerDraft();
  const items = [media('a'), media('b'), media('c')];
  return {
    ...draft,
    mode: 'upload',
    title: 'Before',
    mediaItems: items,
    upload: { uri: items[0].uri, name: items[0].name, type: items[0].type },
    resource: {
      ...draft.resource,
      accessMode: 'free',
      cards: [
        // Names only b: losing b leaves it naming nothing, so it applies to all.
        createPostComposerResourceCard('prompt', { id: 'only-b', appliesToAll: false, mediaKeys: ['key-b'] }),
        createPostComposerResourceCard('guide', { id: 'b-and-c', appliesToAll: false, mediaKeys: ['key-b', 'key-c'] }),
        createPostComposerResourceCard('settings', { id: 'all', appliesToAll: true, mediaKeys: [] }),
      ],
    },
  };
}

describe('composer undo — Undo puts back what the removal took, onto the draft as it is', () => {
  it('keeps what was typed after the removal (the emulator case, 2026-10-22)', () => {
    // A card removed while the package summary had the keyboard, " plus" typed
    // after it, then Undo: restoring the draft as it stood dropped the typing.
    const draft = getDefaultPostComposerDraft();
    const card = createPostComposerResourceCard('prompt', { id: 'prompt', textContent: 'Card body' });
    const before = {
      ...draft,
      resource: { ...draft.resource, accessMode: 'paid' as const, allowRemix: true, cards: [card], summary: 'Lab summary' },
    };
    const taken = takeComposerResourceCard(before, 'prompt')!;
    expect(taken.draft.resource.cards).toEqual([]);

    const typed = { ...taken.draft, resource: { ...taken.draft.resource, summary: 'Lab summary plus' } };
    const restored = putBackComposerRemoval(typed, taken.removal);
    expect(restored.resource.cards).toEqual([card]);
    expect(restored.resource.summary).toBe('Lab summary plus');
    expect(restored.resource.accessMode).toBe('paid');
  });

  describe('media', () => {
    it('comes back to its place with its resource links, and the cover follows the first item', () => {
      const before = mediaPost();
      const taken = takeComposerMedia(before, 'b')!;
      expect(taken.draft.mediaItems.map((item) => item.id)).toEqual(['a', 'c']);
      expect(taken.draft.resource.cards.map(({ mediaKeys, appliesToAll }) => ({ mediaKeys, appliesToAll }))).toEqual([
        { mediaKeys: [], appliesToAll: true },
        { mediaKeys: ['key-c'], appliesToAll: false },
        { mediaKeys: [], appliesToAll: true },
      ]);

      const restored = putBackComposerRemoval({ ...taken.draft, title: 'After' }, taken.removal);
      expect(restored).toEqual({ ...before, title: 'After' });
    });

    it('moves the cover back when the first item returns', () => {
      const before = mediaPost();
      const taken = takeComposerMedia(before, 'a')!;
      expect(taken.draft.upload?.uri).toBe('file:///b.jpg');
      expect(putBackComposerRemoval(taken.draft, taken.removal).upload?.uri).toBe('file:///a.jpg');
    });

    it('leaves a card whose outputs were chosen again since', () => {
      const taken = takeComposerMedia(mediaPost(), 'b')!;
      const rechosen = {
        ...taken.draft,
        resource: {
          ...taken.draft.resource,
          cards: taken.draft.resource.cards.map((card) => (card.id === 'only-b' ? { ...card, appliesToAll: false, mediaKeys: ['key-a'] } : card)),
        },
      };
      const restored = putBackComposerRemoval(rechosen, taken.removal);
      expect(restored.resource.cards.find((card) => card.id === 'only-b')).toMatchObject({ appliesToAll: false, mediaKeys: ['key-a'] });
      expect(restored.resource.cards.find((card) => card.id === 'b-and-c')).toMatchObject({ appliesToAll: false, mediaKeys: ['key-b', 'key-c'] });
    });

    it('goes to the end when the row has grown shorter, and is not put back twice', () => {
      const first = takeComposerMedia(mediaPost(), 'c')!;
      const second = takeComposerMedia(first.draft, 'b')!;
      const restored = putBackComposerRemoval(second.draft, first.removal);
      expect(restored.mediaItems.map((item) => item.id)).toEqual(['a', 'c']);
      expect(putBackComposerRemoval(restored, first.removal)).toBe(restored);
    });

    it('does not take a slot there is no longer room for', () => {
      const taken = takeComposerMedia(mediaPost(), 'b')!;
      const refilled = {
        ...taken.draft,
        mediaItems: Array.from({ length: MEDIA_MAX_ITEMS }, (_, index) => media(`new-${index}`)),
      };
      expect(putBackComposerRemoval(refilled, taken.removal)).toBe(refilled);
    });
  });

  describe('made-with rows', () => {
    it('come back to their place', () => {
      const draft = getDefaultPostComposerDraft();
      const rows = [createMadeWithRow({ toolLabel: 'Kling' }), createMadeWithRow({ toolLabel: 'Veo' }), createMadeWithRow({ toolLabel: 'Flux' })];
      const before = { ...draft, madeWithRows: rows };
      const taken = takeComposerMadeWithRow(before, rows[1].id)!;
      expect(taken.draft.madeWithRows).toEqual([rows[0], rows[2]]);
      expect(putBackComposerRemoval(taken.draft, taken.removal).madeWithRows).toEqual(rows);
    });

    it('replace the blank row that stood in for the last one, unless it has been filled', () => {
      const draft = getDefaultPostComposerDraft();
      const row = draft.madeWithRows[0];
      const taken = takeComposerMadeWithRow(draft, row.id)!;
      expect(taken.draft.madeWithRows).toHaveLength(1);
      expect(taken.draft.madeWithRows[0]).toMatchObject({ toolLabel: '', modelLabel: '' });
      // Taking the same row from the same draft gives the same stand-in, so the screen's two reads agree.
      expect(takeComposerMadeWithRow(draft, row.id)!.draft).toEqual(taken.draft);

      expect(putBackComposerRemoval(taken.draft, taken.removal).madeWithRows).toEqual([row]);

      const filled = { ...taken.draft, madeWithRows: [{ ...taken.draft.madeWithRows[0], toolLabel: 'Runway' }] };
      expect(putBackComposerRemoval(filled, taken.removal).madeWithRows.map((candidate) => candidate.toolLabel)).toEqual(['Manual', 'Runway']);
    });
  });

  describe('resource cards', () => {
    it('switch resources back on when taking the last one switched them off', () => {
      const draft = getDefaultPostComposerDraft();
      const card = createPostComposerResourceCard('prompt', { id: 'prompt' });
      const before = { ...draft, resource: { ...draft.resource, accessMode: 'free' as const, cards: [card] } };
      const taken = takeComposerResourceCard(before, 'prompt')!;
      expect(taken.draft.resource.accessMode).toBe('none');
      expect(putBackComposerRemoval(taken.draft, taken.removal).resource).toMatchObject({ accessMode: 'free', cards: [card] });

      // A choice made since stands.
      const chosen = { ...taken.draft, resource: { ...taken.draft.resource, accessMode: 'paid' as const } };
      expect(putBackComposerRemoval(chosen, taken.removal).resource.accessMode).toBe('paid');
    });

    it('come back to their place among the others', () => {
      const draft = getDefaultPostComposerDraft();
      const cards = ['one', 'two', 'three'].map((id) => createPostComposerResourceCard('prompt', { id }));
      const before = { ...draft, resource: { ...draft.resource, accessMode: 'free' as const, cards } };
      const taken = takeComposerResourceCard(before, 'two')!;
      expect(taken.draft.resource.accessMode).toBe('free');
      expect(putBackComposerRemoval(taken.draft, taken.removal).resource.cards).toEqual(cards);
    });
  });

  it('takes nothing that is not there', () => {
    const draft = mediaPost();
    expect(takeComposerMedia(draft, 'missing')).toBeNull();
    expect(takeComposerMadeWithRow(draft, 'missing')).toBeNull();
    expect(takeComposerResourceCard(draft, 'missing')).toBeNull();
  });
});
