import { beforeEach, describe, expect, it, vi } from 'vitest';

const alertState = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('react-native', () => ({
  Alert: { alert: alertState.alert },
}));

import { registerActionSheetPresenter, type ActionSheetRequest } from '../lib/action-sheet';
import { ApiError } from '../lib/api-client';
import {
  archivePost,
  changePostVisibility,
  deletePost,
  describePostLifecycleError,
  pickPostVisibility,
  resolveLinkedLifecyclePost,
  restorePost,
  toPostLifecyclePost,
  type PostLifecyclePost,
} from '../lib/post-lifecycle';

const publicWithListedRecipe: PostLifecyclePost = {
  id: 'post-1',
  visibility: 'public',
  archivedAt: null,
  bundle: { accessMode: 'free', status: 'published', salesCount: 2 },
};

describe('resolveLinkedLifecyclePost', () => {
  const linked = { linkedPostId: 'post-1', linkedPostVisibility: 'public', linkedPostArchivedAt: null };

  beforeEach(() => {
    alertState.alert.mockReset();
  });

  it('uses linked-post details that already loaded, without another request', async () => {
    const api = { getOwnerPost: vi.fn() };

    await expect(resolveLinkedLifecyclePost({
      api: api as never,
      item: { ...linked, linkedPostBundle: null, linkedPostDetailsLoaded: true },
    })).resolves.toEqual({ id: 'post-1', visibility: 'public', archivedAt: null, bundle: null });
    expect(api.getOwnerPost).not.toHaveBeenCalled();
  });

  it('reads a post whose details never loaded, so a selling recipe is not taken for a plain post', async () => {
    const api = {
      getOwnerPost: vi.fn(async () => ({
        success: true,
        post: {
          id: 'post-1',
          visibility: 'public',
          archivedAt: null,
          bundle: { accessMode: 'paid', status: 'published', salesCount: 3 },
        },
      })),
    };

    await expect(resolveLinkedLifecyclePost({ api: api as never, item: { ...linked, linkedPostDetailsLoaded: false } }))
      .resolves.toMatchObject({ bundle: { accessMode: 'paid', status: 'published', salesCount: 3 } });
    expect(api.getOwnerPost).toHaveBeenCalledWith('post-1');
  });

  it('reports a failed read and hands back nothing to act on', async () => {
    const api = { getOwnerPost: vi.fn(async () => { throw new Error('Network request failed.'); }) };

    await expect(resolveLinkedLifecyclePost({ api: api as never, item: linked })).resolves.toBeNull();
    expect(alertState.alert.mock.calls[0]?.[0]).toBe('Could not load the post');
  });
});

function getAlertAction(label: string, callIndex = 0) {
  const actions = alertState.alert.mock.calls[callIndex]?.[2] as Array<{ text: string; style?: string; onPress?: () => void }> | undefined;
  const action = actions?.find((candidate) => candidate.text === label);
  if (!action) throw new Error(`No alert action "${label}"`);
  return action;
}

describe('post lifecycle', () => {
  beforeEach(() => {
    alertState.alert.mockReset();
  });

  it('normalises whatever record a surface holds into the policy shape', () => {
    expect(toPostLifecyclePost({
      id: 'post-1',
      visibility: 'unlisted',
      archivedAt: undefined,
      bundle: { accessMode: 'paid', status: 'draft', salesCount: 0 },
    })).toEqual({
      id: 'post-1',
      visibility: 'unlisted',
      archivedAt: null,
      bundle: { accessMode: 'paid', status: 'draft', salesCount: 0, freeUnlockCount: 0 },
    });
    expect(toPostLifecyclePost({ id: 'post-2', visibility: 'bogus' }).visibility).toBe('private');
    expect(toPostLifecyclePost({ id: 'post-3', bundle: null }).bundle).toBeNull();
  });

  // Decision 6 (2026-10-17): salesCount counts paid unlocks only. A free unlock
  // is still an unlock its owner keeps, and the server still asks again before
  // deleting a post that has one, so both confirmations read both counts, as
  // the web's src/lib/post-lifecycle-policy.ts does.
  describe('a recipe unlocked only for free', () => {
    const openedRecipe: PostLifecyclePost = {
      ...publicWithListedRecipe,
      bundle: { accessMode: 'free', status: 'published', salesCount: 0, freeUnlockCount: 4 },
    };

    it('still says the people who opened it keep their unlock before it leaves public', async () => {
      const confirm = vi.fn(async () => false);

      await changePostVisibility({ api: { updatePost: vi.fn() }, post: openedRecipe, visibility: 'private', confirm });

      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Its recipe comes off the marketplace until the post is public again; buyers keep their unlock.',
      }));
    });

    it('still warns before a delete that the server will ask again', async () => {
      const confirm = vi.fn(async () => false);

      await deletePost({ api: { deletePost: vi.fn() }, post: openedRecipe, confirm });

      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
        message: 'People have bought its recipe. Archive keeps it resolvable for them; you will be asked again before a forced delete.',
      }));
    });

    it('keeps the free count of the record a surface holds, and of the post it reads', async () => {
      const bundle = { accessMode: 'free' as const, status: 'published', salesCount: 0, freeUnlockCount: 4 };
      expect(toPostLifecyclePost({ id: 'post-1', visibility: 'public', bundle }).bundle)
        .toEqual({ accessMode: 'free', status: 'published', salesCount: 0, freeUnlockCount: 4 });

      const api = { getOwnerPost: vi.fn(async () => ({ success: true, post: { id: 'post-1', visibility: 'public', archivedAt: null, bundle } })) };
      await expect(resolveLinkedLifecyclePost({ api: api as never, item: { linkedPostId: 'post-1', linkedPostDetailsLoaded: false } }))
        .resolves.toMatchObject({ bundle: { salesCount: 0, freeUnlockCount: 4 } });
    });

    it('reads a record that carries no free count as none', async () => {
      const confirm = vi.fn(async () => false);
      const unsold = toPostLifecyclePost({ id: 'post-1', visibility: 'public', bundle: { accessMode: 'free', status: 'published', salesCount: 0 } });

      await deletePost({ api: { deletePost: vi.fn() }, post: unsold, confirm });

      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'This cannot be undone.' }));
    });
  });

  it('asks with the shared policy copy before a listed recipe leaves public, and does nothing on cancel', async () => {
    const api = { updatePost: vi.fn() };
    const confirm = vi.fn(async () => false);

    await expect(changePostVisibility({ api, post: publicWithListedRecipe, visibility: 'private', confirm }))
      .resolves.toBe('cancelled');

    expect(confirm).toHaveBeenCalledWith({
      title: 'Make this post private?',
      message: 'Its recipe comes off the marketplace until the post is public again; buyers keep their unlock.',
      confirmLabel: 'Make private',
    });
    expect(api.updatePost).not.toHaveBeenCalled();
  });

  it('changes visibility in one step when policy has nothing to say', async () => {
    const api = { updatePost: vi.fn(async () => ({ success: true, postId: 'post-1', visibility: 'public' })) };
    const confirm = vi.fn(async () => true);

    await expect(changePostVisibility({
      api,
      post: { ...publicWithListedRecipe, visibility: 'private' },
      visibility: 'public',
      confirm,
    })).resolves.toBe('done');

    expect(confirm).not.toHaveBeenCalled();
    expect(api.updatePost).toHaveBeenCalledWith('post-1', { visibility: 'public' });
  });

  it('ignores a no-op change and an archived post', async () => {
    const api = { updatePost: vi.fn() };
    await expect(changePostVisibility({ api, post: publicWithListedRecipe, visibility: 'public' })).resolves.toBe('cancelled');
    await expect(changePostVisibility({
      api,
      post: { ...publicWithListedRecipe, archivedAt: '2026-08-01T00:00:00.000Z' },
      visibility: 'private',
    })).resolves.toBe('cancelled');
    expect(api.updatePost).not.toHaveBeenCalled();
  });

  // "Please try again." hid the one thing the user needed: why. The server's
  // reason (unsafe text, the quality gate) is shown instead.
  it('reports the server reason when a change is refused', async () => {
    const api = {
      updatePost: vi.fn(async () => {
        throw new ApiError('Add a title before making this post public.', 400, { field: 'title' });
      }),
    };
    const askForPublicIdentity = vi.fn();

    await expect(changePostVisibility({
      api,
      post: { ...publicWithListedRecipe, visibility: 'private', bundle: null },
      visibility: 'public',
      askForPublicIdentity,
    })).resolves.toBe('failed');

    expect(alertState.alert).toHaveBeenCalledWith('Could not update visibility', 'Add a title before making this post public.');
    expect(describePostLifecycleError(new Error('   '), 'Please try again.')).toBe('Please try again.');
    // Only the refusal for the name and handle is answered by asking for them.
    expect(askForPublicIdentity).not.toHaveBeenCalled();
  });

  // A public post needs a claimed handle and a display name, and the server
  // checks them before anything else. A creator making a private post public
  // from a list is asked for both and the change goes out again, where it used
  // to end in "Could not update visibility" with nothing to do about it.
  describe('a public change refused for the name and handle', () => {
    const privatePost: PostLifecyclePost = { ...publicWithListedRecipe, visibility: 'private', bundle: null };
    const profileRefusal = () => new ApiError(
      'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
      400,
      {
        error: 'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
        field: 'profile',
        actionHref: '/profile',
        actionLabel: 'Complete profile and return',
      },
    );
    const savedProfile = { id: 'user-1', username: 'maya-k', displayName: 'Maya K' };

    it('asks for both, and sends the change again once they are saved', async () => {
      const api = {
        updatePost: vi.fn()
          .mockRejectedValueOnce(profileRefusal())
          .mockResolvedValueOnce({ success: true, postId: 'post-1', visibility: 'public' }),
      };
      const askForPublicIdentity = vi.fn(async () => ({ status: 'saved' as const, profile: savedProfile as never }));

      await expect(changePostVisibility({ api, post: privatePost, visibility: 'public', askForPublicIdentity }))
        .resolves.toBe('done');

      expect(askForPublicIdentity).toHaveBeenCalledTimes(1);
      expect(api.updatePost).toHaveBeenCalledTimes(2);
      expect(api.updatePost).toHaveBeenNthCalledWith(2, 'post-1', { visibility: 'public' });
      expect(alertState.alert).not.toHaveBeenCalled();
    });

    it('leaves the post as it was, without a word, when the creator cancels', async () => {
      const api = { updatePost: vi.fn().mockRejectedValueOnce(profileRefusal()) };
      const askForPublicIdentity = vi.fn(async () => ({ status: 'cancelled' as const }));

      await expect(changePostVisibility({ api, post: privatePost, visibility: 'public', askForPublicIdentity }))
        .resolves.toBe('cancelled');

      expect(api.updatePost).toHaveBeenCalledTimes(1);
      expect(alertState.alert).not.toHaveBeenCalled();
    });

    it('reports the refusal when no sheet can ask', async () => {
      const api = { updatePost: vi.fn().mockRejectedValueOnce(profileRefusal()) };
      const askForPublicIdentity = vi.fn(async () => ({ status: 'unavailable' as const }));

      await expect(changePostVisibility({ api, post: privatePost, visibility: 'public', askForPublicIdentity }))
        .resolves.toBe('failed');

      expect(alertState.alert).toHaveBeenCalledWith(
        'Could not update visibility',
        'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
      );
    });

    it('asks once: a refusal after the save is reported, not asked again', async () => {
      const api = {
        updatePost: vi.fn()
          .mockRejectedValueOnce(profileRefusal())
          .mockRejectedValueOnce(new ApiError('Add a title before making this post public.', 400)),
      };
      const askForPublicIdentity = vi.fn(async () => ({ status: 'saved' as const, profile: savedProfile as never }));

      await expect(changePostVisibility({ api, post: privatePost, visibility: 'public', askForPublicIdentity }))
        .resolves.toBe('failed');

      expect(askForPublicIdentity).toHaveBeenCalledTimes(1);
      expect(alertState.alert).toHaveBeenCalledWith('Could not update visibility', 'Add a title before making this post public.');
    });

    it('never asks when the post is going private', async () => {
      const api = { updatePost: vi.fn().mockRejectedValueOnce(profileRefusal()) };
      const askForPublicIdentity = vi.fn();

      await expect(changePostVisibility({
        api,
        post: { ...privatePost, visibility: 'public' },
        visibility: 'private',
        askForPublicIdentity,
      })).resolves.toBe('failed');

      expect(askForPublicIdentity).not.toHaveBeenCalled();
    });

    it('does not ask a creator whose profile can already publish', async () => {
      const api = { updatePost: vi.fn(async () => ({ success: true, postId: 'post-1', visibility: 'public' })) };
      const askForPublicIdentity = vi.fn();

      await expect(changePostVisibility({ api, post: privatePost, visibility: 'public', askForPublicIdentity }))
        .resolves.toBe('done');

      expect(askForPublicIdentity).not.toHaveBeenCalled();
      expect(api.updatePost).toHaveBeenCalledTimes(1);
    });
  });

  // Decision 12 (2026-10-17): a post is Public or Private. The server stores a
  // requested unlisted as private, so an old unlisted post reads as Private.
  it('offers public and private through an action sheet, with the current one shown as state', () => {
    const presented: ActionSheetRequest[] = [];
    const unregister = registerActionSheetPresenter((request) => presented.push(request));
    const onPick = vi.fn();

    try {
      pickPostVisibility('unlisted', onPick);
    } finally {
      unregister();
    }

    // A picker is a set of choices following an intentional action, which is an
    // action sheet's job — and not an alert's, which caps at three buttons and
    // is why the current state used to have to double as the way out.
    expect(alertState.alert).not.toHaveBeenCalled();
    expect(presented).toHaveLength(1);
    expect(presented[0].title).toBe('Change visibility');
    expect(presented[0].actions.map((action) => action.label)).toEqual(['Public', 'Private']);

    const current = presented[0].actions.find((action) => action.label === 'Private');
    expect(current?.detail).toBe('Current');
    expect(current?.disabled).toBe(true);

    presented[0].actions.find((action) => action.label === 'Public')?.onPress?.();
    expect(onPick).toHaveBeenCalledWith('public');
  });

  it('falls back to the system dialog when no host is mounted, cancel last', () => {
    const onPick = vi.fn();
    pickPostVisibility('unlisted', onPick);

    const actions = alertState.alert.mock.calls[0][2] as Array<{ text: string; style?: string }>;
    expect(actions.map((action) => action.text)).toEqual(['Public', 'Private', 'Cancel']);
    expect(actions.at(-1)?.style).toBe('cancel');
  });

  it('confirms an archive and restores without asking', async () => {
    const api = { archivePost: vi.fn(async () => ({ success: true, archived: true })), restorePost: vi.fn(async () => ({ success: true, restored: true })) };
    const confirm = vi.fn(async () => true);

    await expect(archivePost({ api, post: publicWithListedRecipe, confirm })).resolves.toBe('done');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Archive this post?', confirmLabel: 'Archive' }));
    expect(api.archivePost).toHaveBeenCalledWith('post-1');

    confirm.mockClear();
    await expect(restorePost({
      api,
      post: { ...publicWithListedRecipe, archivedAt: '2026-08-01T00:00:00.000Z' },
      confirm,
    })).resolves.toBe('done');
    expect(confirm).not.toHaveBeenCalled();
    expect(api.restorePost).toHaveBeenCalledWith('post-1');
  });

  it('deletes in one confirmed step, and asks again with the stakes when buyers exist', async () => {
    const api = {
      deletePost: vi.fn()
        .mockRejectedValueOnce(new ApiError('This post already has paid unlocks.', 409, { requiresForceDelete: true }))
        .mockResolvedValueOnce({ success: true, deleted: true }),
    };
    const confirm = vi.fn(async () => true);

    await expect(deletePost({ api, post: publicWithListedRecipe, confirm })).resolves.toBe('done');

    expect(confirm).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: 'Delete this post permanently?',
      message: 'People have bought its recipe. Archive keeps it resolvable for them; you will be asked again before a forced delete.',
      tone: 'danger',
    }));
    expect(confirm).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: 'People have bought this recipe',
      confirmLabel: 'Delete anyway',
      tone: 'danger',
    }));
    expect(api.deletePost).toHaveBeenNthCalledWith(1, 'post-1');
    expect(api.deletePost).toHaveBeenNthCalledWith(2, 'post-1', { force: true });
  });

  it('keeps a sold post when the forced delete is declined', async () => {
    const api = {
      deletePost: vi.fn().mockRejectedValueOnce(new ApiError('Sold.', 409, { requiresForceDelete: true })),
    };
    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(deletePost({ api, post: publicWithListedRecipe, confirm })).resolves.toBe('cancelled');
    expect(api.deletePost).toHaveBeenCalledTimes(1);
    expect(alertState.alert).not.toHaveBeenCalled();
  });
});
