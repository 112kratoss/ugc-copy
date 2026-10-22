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
  MAX_MADE_WITH_ROWS,
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

    it('gives back the cover upload it found, so an edited post reads as unchanged again', () => {
      // Editing builds the upload from the post (its URL, its title), not from its first item.
      const edited = { ...mediaPost(), upload: { uri: 'https://cdn.example/post.jpg', name: 'Before', type: 'image/jpeg' } };
      for (const id of ['a', 'b']) {
        const taken = takeComposerMedia(edited, id)!;
        expect(putBackComposerRemoval(taken.draft, taken.removal)).toEqual(edited);
      }
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

    it('keep the last one, as the screen offers no Remove on it', () => {
      const draft = getDefaultPostComposerDraft();
      expect(draft.madeWithRows).toHaveLength(1);
      expect(takeComposerMadeWithRow(draft, draft.madeWithRows[0].id)).toBeNull();
    });

    it('do not come back past the five a post carries', () => {
      // Remove one of five, add another while the offer stands, then Undo: a sixth row would be
      // drawn with Add hidden, and publishing keeps five (MAX_MADE_WITH_ROWS).
      const draft = getDefaultPostComposerDraft();
      const rows = Array.from({ length: MAX_MADE_WITH_ROWS }, (_, index) => createMadeWithRow({ toolLabel: `Tool ${index + 1}` }));
      const taken = takeComposerMadeWithRow({ ...draft, madeWithRows: rows }, rows[1].id)!;
      const refilled = { ...taken.draft, madeWithRows: [...taken.draft.madeWithRows, createMadeWithRow()] };
      expect(putBackComposerRemoval(refilled, taken.removal)).toBe(refilled);
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
