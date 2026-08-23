import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
}));

const policyMocks = vi.hoisted(() => ({
  getPostLifecycleConfirmation: vi.fn(),
}));

vi.mock('@/lib/post-lifecycle-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/post-lifecycle-client')>()),
  ...clientMocks,
}));
vi.mock('@/app/components/feedback-state', () => feedbackMocks);
vi.mock('@/lib/post-lifecycle-policy', () => policyMocks);

import { PostLifecycleRequestError } from '@/lib/post-lifecycle-client';
import {
  usePostLifecycle,
  type PostLifecycleTarget,
  type UsePostLifecycleOptions,
} from '@/app/components/usePostLifecycle';

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
      new PostLifecycleRequestError('Complete your profile before publishing publicly.', { status: 400 }),
    );
    const onPatch = vi.fn();
    const onSettled = vi.fn();
    const privatePost: PostLifecycleTarget = { ...basePost, visibility: 'private', bundle: { accessMode: 'free', status: 'draft', salesCount: 0 } };
    render(<Harness post={privatePost} onPatch={onPatch} onSettled={onSettled} />);

    fireEvent.click(screen.getByRole('button', { name: 'go public' }));

    await waitFor(() => {
      expect(feedbackMocks.pushToast).toHaveBeenCalledWith({
        tone: 'error',
        message: 'Complete your profile before publishing publicly.',
      });
    });
    expect(onPatch.mock.calls).toEqual([
      ['post-1', { visibility: 'public', bundleStatus: 'draft' }],
      ['post-1', { visibility: 'private', bundleStatus: 'draft' }],
    ]);
    expect(onSettled).not.toHaveBeenCalled();
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
    expect(onPatch).toHaveBeenCalledWith('post-1', { archivedAt: null });
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
