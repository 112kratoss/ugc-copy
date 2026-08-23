import { beforeEach, describe, expect, it, vi } from 'vitest';

const alertState = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('react-native', () => ({
  Alert: { alert: alertState.alert },
}));

import { ApiError } from '../lib/api-client';
import {
  archivePost,
  changePostVisibility,
  deletePost,
  describePostLifecycleError,
  pickPostVisibility,
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

function getAlertAction(label: string, callIndex = 0) {
  const actions = alertState.alert.mock.calls[callIndex]?.[2] as Array<{ text: string; onPress?: () => void }> | undefined;
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
      bundle: { accessMode: 'paid', status: 'draft', salesCount: 0 },
    });
    expect(toPostLifecyclePost({ id: 'post-2', visibility: 'bogus' }).visibility).toBe('private');
    expect(toPostLifecyclePost({ id: 'post-3', bundle: null }).bundle).toBeNull();
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
  // reason (profile incomplete, unsafe text, quality gate) is shown instead.
  it('reports the server reason when a change is refused', async () => {
    const api = {
      updatePost: vi.fn(async () => {
        throw new ApiError('Complete your profile before publishing publicly.', 400);
      }),
    };

    await expect(changePostVisibility({
      api,
      post: { ...publicWithListedRecipe, visibility: 'private', bundle: null },
      visibility: 'public',
    })).resolves.toBe('failed');

    expect(alertState.alert).toHaveBeenCalledWith('Could not update visibility', 'Complete your profile before publishing publicly.');
    expect(describePostLifecycleError(new Error('   '), 'Please try again.')).toBe('Please try again.');
  });

  it('offers the three states and marks the current one', () => {
    const onPick = vi.fn();
    pickPostVisibility('unlisted', onPick);

    const actions = alertState.alert.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    expect(actions.map((action) => action.text)).toEqual(['Public', 'Unlisted (current)', 'Private', 'Cancel']);
    getAlertAction('Unlisted (current)').onPress?.();
    expect(onPick).not.toHaveBeenCalled();
    getAlertAction('Private').onPress?.();
    expect(onPick).toHaveBeenCalledWith('private');
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
