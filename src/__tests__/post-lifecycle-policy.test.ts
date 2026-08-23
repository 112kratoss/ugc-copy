import { describe, expect, it } from 'vitest';

import {
  getPostLifecycleConfirmation,
  type PostLifecycleSubject,
} from '@/lib/post-lifecycle-policy';

const listedRecipe: PostLifecycleSubject['bundle'] = { accessMode: 'paid', status: 'published', salesCount: 0 };
const soldRecipe: PostLifecycleSubject['bundle'] = { accessMode: 'paid', status: 'published', salesCount: 3 };
const draftRecipe: PostLifecycleSubject['bundle'] = { accessMode: 'free', status: 'draft', salesCount: 0 };

const publicPost = (bundle: PostLifecycleSubject['bundle']): PostLifecycleSubject => ({
  visibility: 'public',
  archivedAt: null,
  bundle,
});

describe('post lifecycle confirmation policy', () => {
  describe('visibility', () => {
    // Leaving public demotes a listed recipe and nothing reverses that
    // automatically, so it is the one transition that gets a pause.
    it('asks before taking a post with a listed recipe private', () => {
      expect(getPostLifecycleConfirmation({ type: 'visibility', next: 'private' }, publicPost(listedRecipe))).toEqual({
        title: 'Make this post private?',
        message: 'Its recipe comes off the marketplace and goes back to draft. Making the post public again does not relist it — save it from the editor to relist.',
        confirmLabel: 'Make private',
      });
    });

    it('asks before taking a post with a listed recipe unlisted, since that demotes the recipe too', () => {
      expect(getPostLifecycleConfirmation({ type: 'visibility', next: 'unlisted' }, publicPost(listedRecipe))).toEqual({
        title: 'Make this post unlisted?',
        message: 'Its recipe comes off the marketplace and goes back to draft. Making the post public again does not relist it — save it from the editor to relist.',
        confirmLabel: 'Make unlisted',
      });
    });

    it('reassures that buyers keep their unlock when the recipe has sold', () => {
      const confirmation = getPostLifecycleConfirmation({ type: 'visibility', next: 'private' }, publicPost(soldRecipe));
      expect(confirmation?.message).toBe(
        'Its recipe comes off the marketplace and goes back to draft; buyers keep their unlock. Making the post public again does not relist it — save it from the editor to relist.',
      );
    });

    it('keys on the recipe being listed, not on whether it has sold', () => {
      expect(getPostLifecycleConfirmation({ type: 'visibility', next: 'private' }, publicPost(draftRecipe))).toBeNull();
      expect(getPostLifecycleConfirmation({ type: 'visibility', next: 'private' }, publicPost(null))).toBeNull();
    });

    it('lets a post go public in one click; the quality gate fails loudly on its own', () => {
      const privateWithListedRecipe: PostLifecycleSubject = { visibility: 'private', archivedAt: null, bundle: listedRecipe };
      expect(getPostLifecycleConfirmation({ type: 'visibility', next: 'public' }, privateWithListedRecipe)).toBeNull();
      expect(getPostLifecycleConfirmation({ type: 'visibility', next: 'public' }, { ...privateWithListedRecipe, visibility: 'unlisted' })).toBeNull();
    });

    it('moves between unlisted and private in one click, because the recipe is already demoted', () => {
      const unlisted: PostLifecycleSubject = { visibility: 'unlisted', archivedAt: null, bundle: listedRecipe };
      expect(getPostLifecycleConfirmation({ type: 'visibility', next: 'private' }, unlisted)).toBeNull();
      expect(getPostLifecycleConfirmation({ type: 'visibility', next: 'unlisted' }, { ...unlisted, visibility: 'private' })).toBeNull();
    });
  });

  it('always confirms an archive', () => {
    expect(getPostLifecycleConfirmation({ type: 'archive' }, publicPost(null))).toEqual({
      title: 'Archive this post?',
      message: 'It will disappear from public surfaces until you restore it.',
      confirmLabel: 'Archive',
    });
  });

  it('never confirms a restore', () => {
    expect(getPostLifecycleConfirmation({ type: 'restore' }, { ...publicPost(null), archivedAt: '2026-08-01T00:00:00.000Z' })).toBeNull();
  });

  it('confirms a delete as destructive, and warns about buyers only when there are some', () => {
    expect(getPostLifecycleConfirmation({ type: 'delete' }, publicPost(null))).toEqual({
      title: 'Delete this post permanently?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    expect(getPostLifecycleConfirmation({ type: 'delete' }, publicPost(soldRecipe))?.message).toBe(
      'People have bought its recipe. Archive keeps it resolvable for them; you will be asked again before a forced delete.',
    );
  });
});
