import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  requestPostVisibilityChange: vi.fn(),
  requestPostArchive: vi.fn(),
  requestPostRestore: vi.fn(),
  requestPostDelete: vi.fn(),
}));

const feedbackMocks = vi.hoisted(() => ({
  pushToast: vi.fn(),
  requestConfirmation: vi.fn(),
  requestPublicIdentity: vi.fn(),
}));

const policyMocks = vi.hoisted(() => ({
  getPostLifecycleConfirmation: vi.fn(),
}));

vi.mock('@/lib/post-lifecycle-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/post-lifecycle-client')>()),
  ...clientMocks,
}));
vi.mock('@/components/feedback-state', () => feedbackMocks);
vi.mock('@/lib/post-lifecycle-policy', () => policyMocks);

import { PostLifecycleRequestError } from '@/lib/post-lifecycle-client';
import {
  usePostLifecycle,
  type PostLifecycleTarget,
  type UsePostLifecycleOptions,
} from '@/components/usePostLifecycle';

const basePost: PostLifecycleTarget = {
  id: 'post-1',
  generationId: 'gen-1',
  visibility: 'public',
  archivedAt: null,
  bundle: { accessMode: 'paid', status: 'published', salesCount: 0 },
};

function Harness({
  post = basePost,
  ...options
}: Partial<UsePostLifecycleOptions> & { post?: PostLifecycleTarget }) {
  const lifecycle = usePostLifecycle({
    accessToken: 'token',
    onAuthRequired: vi.fn(),
    onPatch: vi.fn(),
    ...options,
  });

  return (
    <>
      <button type="button" onClick={() => void lifecycle.setVisibility(post, 'private')}>go private</button>
      <button type="button" onClick={() => void lifecycle.setVisibility(post, 'public')}>go public</button>
      <button type="button" onClick={() => void lifecycle.archive(post)}>archive</button>
      <button type="button" onClick={() => void lifecycle.restore(post)}>restore</button>
      <button type="button" onClick={() => void lifecycle.remove(post)}>delete</button>
      <output>{lifecycle.pendingAction(post.id) ?? 'idle'}</output>
    </>
  );
}

describe('usePostLifecycle', () => {
  beforeEach(() => {
    policyMocks.getPostLifecycleConfirmation.mockReturnValue(null);
    feedbackMocks.requestConfirmation.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('moves the surface first, then settles on the server answer with a toast', async () => {
    let resolveRequest: (value: unknown) => void = () => {};
    clientMocks.requestPostVisibilityChange.mockImplementation(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const onPatch = vi.fn();
    const onSettled = vi.fn();
    render(<Harness onPatch={onPatch} onSettled={onSettled} />);

    fireEvent.click(screen.getByRole('button', { name: 'go private' }));

    // Optimistic: visibility flips and the published recipe is shown as a draft.
    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith('post-1', { visibility: 'private', bundleStatus: 'draft' });
    });
    expect(screen.getByRole('status')).toHaveTextContent('visibility');
    expect(clientMocks.requestPostVisibilityChange).toHaveBeenCalledWith({
      post: basePost,
      visibility: 'private',
      accessToken: 'token',
    });

    resolveRequest({
      visibility: 'private',
      ownerPath: '/post/post-1/edit',
      showcasePath: null,
      resourceBundleStatus: 'draft',
    });

    await waitFor(() => {
      expect(onSettled).toHaveBeenCalledWith({
        type: 'visibility',
        postId: 'post-1',
        visibility: 'private',
        ownerPath: '/post/post-1/edit',
        showcasePath: null,
      });
    });
    expect(onPatch).toHaveBeenLastCalledWith('post-1', { visibility: 'private', bundleStatus: 'draft' });
    expect(feedbackMocks.pushToast).toHaveBeenCalledWith({ tone: 'success', message: 'Post is private.' });
    expect(screen.getByRole('status')).toHaveTextContent('idle');
  });

  it('puts the surface back and reports the server message when the request fails', async () => {
    clientMocks.requestPostVisibilityChange.mockRejectedValue(
      new PostLifecycleRequestError('Add a title before making this post public.', { status: 400 }),
    );
    const onPatch = vi.fn();
    const onSettled = vi.fn();
    const privatePost: PostLifecycleTarget = { ...basePost, visibility: 'private', bundle: { accessMode: 'free', status: 'draft', salesCount: 0 } };
    render(<Harness post={privatePost} onPatch={onPatch} onSettled={onSettled} />);

    fireEvent.click(screen.getByRole('button', { name: 'go public' }));

    await waitFor(() => {
      expect(feedbackMocks.pushToast).toHaveBeenCalledWith({
        tone: 'error',
        message: 'Add a title before making this post public.',
      });
    });
    // Going public shows the recipe as live straight away (the server
    // re-promotes it with the post); the failure puts both back.
    expect(onPatch.mock.calls).toEqual([
      ['post-1', { visibility: 'public', bundleStatus: 'published' }],
      ['post-1', { visibility: 'private', bundleStatus: 'draft' }],
    ]);
    expect(onSettled).not.toHaveBeenCalled();
    // Only the refusal for the name and handle is answered by asking for them.
    expect(feedbackMocks.requestPublicIdentity).not.toHaveBeenCalled();
  });

  describe('a public change refused for the name and handle', () => {
    const privatePost: PostLifecycleTarget = { ...basePost, visibility: 'private', bundle: null };
    const profileRefusal = () => new PostLifecycleRequestError(
      'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
      { status: 400, field: 'profile' },
    );
    const savedProfile = { id: 'user-1', username: 'maya-k', displayName: 'Maya K' };
    const publicResult = { visibility: 'public', ownerPath: '/post/post-1/edit', showcasePath: '/showcase/post-1', resourceBundleStatus: null };

    it('asks for both, saves them, and sends the change again', async () => {
      clientMocks.requestPostVisibilityChange
        .mockRejectedValueOnce(profileRefusal())
        .mockResolvedValueOnce(publicResult);
      feedbackMocks.requestPublicIdentity.mockResolvedValue({ status: 'saved', profile: savedProfile });
      const onPatch = vi.fn();
      const onSettled = vi.fn();
      const onPublicIdentitySaved = vi.fn();
      const signedInUser = { email: 'maya.k@example.com', user_metadata: { full_name: 'Maya Kapoor' } };
      render(
        <Harness
          post={privatePost}
          signedInUser={signedInUser}
          onPatch={onPatch}
          onSettled={onSettled}
          onPublicIdentitySaved={onPublicIdentitySaved}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'go public' }));

      await waitFor(() => {
        expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ type: 'visibility', visibility: 'public' }));
      });
      // The question fills its fields from the sign-in, as the composers do.
      expect(feedbackMocks.requestPublicIdentity).toHaveBeenCalledWith({ getAccessToken: expect.any(Function), signedInUser });
      expect(feedbackMocks.requestPublicIdentity.mock.calls[0][0].getAccessToken()).toBe('token');
      expect(onPublicIdentitySaved).toHaveBeenCalledWith(savedProfile);
      expect(clientMocks.requestPostVisibilityChange).toHaveBeenCalledTimes(2);
      // The surface stays public while it asks: it was never put back.
      expect(onPatch.mock.calls).toEqual([
        ['post-1', { visibility: 'public', bundleStatus: null }],
        ['post-1', { visibility: 'public', bundleStatus: null }],
      ]);
      expect(feedbackMocks.pushToast).toHaveBeenCalledWith({ tone: 'success', message: 'Name and handle saved. Post is public.' });
      expect(feedbackMocks.pushToast).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent('idle');
    });

    it('asks and sends the change again with the token the page holds by then', async () => {
      clientMocks.requestPostVisibilityChange
        .mockRejectedValueOnce(profileRefusal())
        .mockResolvedValueOnce(publicResult);
      let answerQuestion: (outcome: unknown) => void = () => undefined;
      feedbackMocks.requestPublicIdentity.mockImplementation(() => new Promise((resolve) => {
        answerQuestion = resolve;
      }));
      const { rerender } = render(<Harness post={privatePost} accessToken="token" />);

      fireEvent.click(screen.getByRole('button', { name: 'go public' }));
      await waitFor(() => {
        expect(feedbackMocks.requestPublicIdentity).toHaveBeenCalledTimes(1);
      });
      // The session refreshes while the question is up.
      rerender(<Harness post={privatePost} accessToken="refreshed-token" />);
      expect(feedbackMocks.requestPublicIdentity.mock.calls[0][0].getAccessToken()).toBe('refreshed-token');

      await act(async () => {
        answerQuestion({ status: 'saved', profile: savedProfile });
      });

      await waitFor(() => {
        expect(clientMocks.requestPostVisibilityChange).toHaveBeenCalledTimes(2);
      });
      expect(clientMocks.requestPostVisibilityChange.mock.calls[0][0]).toEqual(expect.objectContaining({ accessToken: 'token' }));
      expect(clientMocks.requestPostVisibilityChange.mock.calls[1][0]).toEqual(expect.objectContaining({ accessToken: 'refreshed-token' }));
    });

    it('holds the post as busy while it asks', async () => {
      clientMocks.requestPostVisibilityChange.mockRejectedValueOnce(profileRefusal());
      feedbackMocks.requestPublicIdentity.mockImplementation(() => new Promise(() => {}));
      render(<Harness post={privatePost} />);

      fireEvent.click(screen.getByRole('button', { name: 'go public' }));

      await waitFor(() => {
        expect(feedbackMocks.requestPublicIdentity).toHaveBeenCalledTimes(1);
      });
      expect(screen.getByRole('status')).toHaveTextContent('visibility');
    });

    it('puts the post back without a word when the creator cancels', async () => {
      clientMocks.requestPostVisibilityChange.mockRejectedValueOnce(profileRefusal());
      feedbackMocks.requestPublicIdentity.mockResolvedValue({ status: 'cancelled' });
      const onPatch = vi.fn();
      const onSettled = vi.fn();
      render(<Harness post={privatePost} onPatch={onPatch} onSettled={onSettled} />);

      fireEvent.click(screen.getByRole('button', { name: 'go public' }));

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('idle');
      });
      expect(onPatch.mock.calls).toEqual([
        ['post-1', { visibility: 'public', bundleStatus: null }],
        ['post-1', { visibility: 'private', bundleStatus: null }],
      ]);
      expect(clientMocks.requestPostVisibilityChange).toHaveBeenCalledTimes(1);
      expect(feedbackMocks.pushToast).not.toHaveBeenCalled();
      expect(onSettled).not.toHaveBeenCalled();
    });

    it('reports the refusal when nothing can draw the question', async () => {
      clientMocks.requestPostVisibilityChange.mockRejectedValueOnce(profileRefusal());
      feedbackMocks.requestPublicIdentity.mockResolvedValue({ status: 'unavailable' });
      render(<Harness post={privatePost} />);

      fireEvent.click(screen.getByRole('button', { name: 'go public' }));

      await waitFor(() => {
        expect(feedbackMocks.pushToast).toHaveBeenCalledWith({
          tone: 'error',
          message: 'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
        });
      });
      expect(clientMocks.requestPostVisibilityChange).toHaveBeenCalledTimes(1);
    });

    it('asks once: a second refusal after the save is reported, not asked again', async () => {
      clientMocks.requestPostVisibilityChange
        .mockRejectedValueOnce(profileRefusal())
        .mockRejectedValueOnce(profileRefusal());
      feedbackMocks.requestPublicIdentity.mockResolvedValue({ status: 'saved', profile: savedProfile });
      const onPatch = vi.fn();
      render(<Harness post={privatePost} onPatch={onPatch} />);

      fireEvent.click(screen.getByRole('button', { name: 'go public' }));

      await waitFor(() => {
        expect(feedbackMocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }));
      });
      expect(feedbackMocks.requestPublicIdentity).toHaveBeenCalledTimes(1);
      expect(onPatch).toHaveBeenLastCalledWith('post-1', { visibility: 'private', bundleStatus: null });
    });

    it('never asks when the post is going private', async () => {
      clientMocks.requestPostVisibilityChange.mockRejectedValueOnce(profileRefusal());
      render(<Harness />);

      fireEvent.click(screen.getByRole('button', { name: 'go private' }));

      await waitFor(() => {
        expect(feedbackMocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }));
      });
      expect(feedbackMocks.requestPublicIdentity).not.toHaveBeenCalled();
    });

    it('does not ask a creator whose profile can already publish', async () => {
      clientMocks.requestPostVisibilityChange.mockResolvedValueOnce(publicResult);
      render(<Harness post={privatePost} />);

      fireEvent.click(screen.getByRole('button', { name: 'go public' }));

      await waitFor(() => {
        expect(feedbackMocks.pushToast).toHaveBeenCalledWith({ tone: 'success', message: 'Post is public.' });
      });
      expect(feedbackMocks.requestPublicIdentity).not.toHaveBeenCalled();
      expect(clientMocks.requestPostVisibilityChange).toHaveBeenCalledTimes(1);
    });
  });

  it('asks first when policy says so and stops cleanly on cancel', async () => {
    policyMocks.getPostLifecycleConfirmation.mockReturnValue({
      title: 'Take this post private?',
      message: 'Its recipe listing will be unlisted.',
      confirmLabel: 'Make private',
    });
    feedbackMocks.requestConfirmation.mockResolvedValue(false);
    const onPatch = vi.fn();
    render(<Harness onPatch={onPatch} />);

    fireEvent.click(screen.getByRole('button', { name: 'go private' }));

    await waitFor(() => {
      expect(feedbackMocks.requestConfirmation).toHaveBeenCalledWith({
        title: 'Take this post private?',
        message: 'Its recipe listing will be unlisted.',
        confirmLabel: 'Make private',
      });
    });
    expect(policyMocks.getPostLifecycleConfirmation).toHaveBeenCalledWith({ type: 'visibility', next: 'private' }, basePost);
    expect(onPatch).not.toHaveBeenCalled();
    expect(clientMocks.requestPostVisibilityChange).not.toHaveBeenCalled();
  });

  it('archives optimistically and restores the previous state if the server refuses', async () => {
    clientMocks.requestPostArchive.mockRejectedValue(new Error('Archive is unavailable right now.'));
    const onPatch = vi.fn();
    render(<Harness onPatch={onPatch} />);

    fireEvent.click(screen.getByRole('button', { name: 'archive' }));

    await waitFor(() => {
      expect(feedbackMocks.pushToast).toHaveBeenCalledWith({ tone: 'error', message: 'Archive is unavailable right now.' });
    });
    expect(onPatch).toHaveBeenCalledTimes(2);
    expect(onPatch.mock.calls[0][1]).toEqual({ archivedAt: expect.any(String), bundleStatus: 'draft' });
    expect(onPatch.mock.calls[1][1]).toEqual({ archivedAt: null, bundleStatus: 'published' });
  });

  it('restores an archived post', async () => {
    clientMocks.requestPostRestore.mockResolvedValue(undefined);
    const onPatch = vi.fn();
    const onSettled = vi.fn();
    render(<Harness post={{ ...basePost, archivedAt: '2026-08-01T00:00:00.000Z' }} onPatch={onPatch} onSettled={onSettled} />);

    fireEvent.click(screen.getByRole('button', { name: 'restore' }));

    await waitFor(() => {
      expect(onSettled).toHaveBeenCalledWith({ type: 'restore', postId: 'post-1' });
    });
    // A restored public post re-exposes its recipe along with itself.
    expect(onPatch).toHaveBeenCalledWith('post-1', { archivedAt: null, bundleStatus: 'published' });
    expect(feedbackMocks.pushToast).toHaveBeenCalledWith({ tone: 'success', message: 'Post restored.' });
  });

  it('does not remove a post until the server has, and asks again before a forced delete', async () => {
    clientMocks.requestPostDelete
      .mockResolvedValueOnce({ deleted: false, requiresForceDelete: true })
      .mockResolvedValueOnce({ deleted: true, tombstoned: true });
    feedbackMocks.requestConfirmation.mockResolvedValue(true);
    const onPatch = vi.fn();
    const onRemoved = vi.fn();
    render(<Harness onPatch={onPatch} onRemoved={onRemoved} />);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));

    await waitFor(() => {
      expect(onRemoved).toHaveBeenCalledWith('post-1');
    });
    expect(onPatch).not.toHaveBeenCalled();
    expect(clientMocks.requestPostDelete).toHaveBeenNthCalledWith(1, { postId: 'post-1', accessToken: 'token', force: false });
    expect(feedbackMocks.requestConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      title: 'People have bought this recipe',
      confirmLabel: 'Delete anyway',
      tone: 'danger',
    }));
    expect(clientMocks.requestPostDelete).toHaveBeenNthCalledWith(2, { postId: 'post-1', accessToken: 'token', force: true });
    expect(feedbackMocks.pushToast).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Post deleted. Buyers keep access to its recipe.',
    });
  });

  it('keeps a sold post when the forced delete is declined', async () => {
    clientMocks.requestPostDelete.mockResolvedValueOnce({ deleted: false, requiresForceDelete: true });
    feedbackMocks.requestConfirmation.mockResolvedValue(false);
    const onRemoved = vi.fn();
    render(<Harness onRemoved={onRemoved} />);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));

    await waitFor(() => {
      expect(clientMocks.requestPostDelete).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('idle');
    });
    expect(onRemoved).not.toHaveBeenCalled();
    expect(feedbackMocks.pushToast).not.toHaveBeenCalled();
  });

  it('sends a signed-out viewer to sign in instead of making a request', async () => {
    const onAuthRequired = vi.fn();
    render(<Harness accessToken={null} onAuthRequired={onAuthRequired} />);

    fireEvent.click(screen.getByRole('button', { name: 'archive' }));

    await waitFor(() => {
      expect(onAuthRequired).toHaveBeenCalledTimes(1);
    });
    expect(clientMocks.requestPostArchive).not.toHaveBeenCalled();
  });

  it('ignores a second action on a post while one is in flight', async () => {
    clientMocks.requestPostVisibilityChange.mockImplementation(() => new Promise(() => {}));
    const onPatch = vi.fn();
    render(<Harness onPatch={onPatch} />);

    fireEvent.click(screen.getByRole('button', { name: 'go private' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('visibility');
    });
    fireEvent.click(screen.getByRole('button', { name: 'archive' }));

    await waitFor(() => {
      expect(policyMocks.getPostLifecycleConfirmation).toHaveBeenCalledWith({ type: 'archive' }, basePost);
    });
    expect(clientMocks.requestPostArchive).not.toHaveBeenCalled();
    expect(onPatch).toHaveBeenCalledTimes(1);
  });
});
