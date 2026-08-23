'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  PostLifecycleRequestError,
  requestPostArchive,
  requestPostDelete,
  requestPostRestore,
  requestPostVisibilityChange,
  type PostVisibility,
} from '@/lib/post-lifecycle-client';
import {
  getPostLifecycleConfirmation,
  type PostLifecycleSubject,
} from '@/lib/post-lifecycle-policy';

import { pushToast, requestConfirmation } from './feedback-state';

export interface PostLifecycleTarget extends PostLifecycleSubject {
  id: string;
  generationId: string | null;
}

export type PostLifecycleActionType = 'visibility' | 'archive' | 'restore' | 'delete';

/** The fields a lifecycle action can change on a surface's local copy of a post. */
export interface PostLifecyclePatch {
  visibility?: PostVisibility;
  archivedAt?: string | null;
  bundleStatus?: 'draft' | 'published' | null;
}

export interface PostLifecycleEvent {
  type: PostLifecycleActionType;
  postId: string;
  /** The visibility the server confirmed, for `visibility` events. */
  visibility?: PostVisibility;
  ownerPath?: string | null;
  showcasePath?: string | null;
}

export interface UsePostLifecycleOptions {
  accessToken: string | null;
  /** Signed-out viewers are sent here instead of to a request. */
  onAuthRequired: () => void;
  /**
   * Apply a patch to the surface's own state. Reversible actions call this
   * optimistically before the request and again with the server's answer
   * (or the reverse patch if the request fails).
   */
  onPatch: (postId: string, patch: PostLifecyclePatch) => void;
  /** A post was deleted on the server. Never called optimistically. */
  onRemoved?: (postId: string) => void;
  /** After any action the server accepted. */
  onSettled?: (event: PostLifecycleEvent) => void;
}

const VISIBILITY_TOAST: Record<PostVisibility, string> = {
  public: 'Post is public.',
  unlisted: 'Post is unlisted. Only people with the link can see it.',
  private: 'Post is private.',
};

function describeError(error: unknown, fallback: string): string {
  if (error instanceof PostLifecycleRequestError || error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
}

/**
 * Visibility, archive, restore, and delete for posts the viewer owns — one
 * flow for every owner surface: confirm when policy says so, update the
 * surface first for reversible actions, talk to the right endpoint, and
 * report the outcome as a toast.
 *
 * Reversible actions (visibility, archive, restore) are optimistic and roll
 * back on failure. Delete is not: the confirmation already gives it a beat,
 * and a post that vanished and reappeared would read as a bug.
 */
export function usePostLifecycle({
  accessToken,
  onAuthRequired,
  onPatch,
  onRemoved,
  onSettled,
}: UsePostLifecycleOptions) {
  const [pending, setPending] = useState<Record<string, PostLifecycleActionType>>({});
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const beginAction = useCallback((postId: string, action: PostLifecycleActionType): boolean => {
    if (pendingRef.current[postId]) {
      return false;
    }
    setPending((current) => ({ ...current, [postId]: action }));
    return true;
  }, []);

  const endAction = useCallback((postId: string) => {
    setPending((current) => {
      if (!(postId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[postId];
      return next;
    });
  }, []);

  const setVisibility = useCallback(async (
    post: PostLifecycleTarget,
    next: PostVisibility,
  ): Promise<boolean> => {
    if (!accessToken) {
      onAuthRequired();
      return false;
    }
    if (post.archivedAt || next === post.visibility) {
      return false;
    }

    const confirmation = getPostLifecycleConfirmation({ type: 'visibility', next }, post);
    if (confirmation && !(await requestConfirmation(confirmation))) {
      return false;
    }
    if (!beginAction(post.id, 'visibility')) {
      return false;
    }

    const previousBundleStatus = post.bundle?.status ?? null;
    // Mirror the server: leaving `public` demotes a published recipe to a
    // draft. Returning to `public` does not re-promote it by itself.
    onPatch(post.id, {
      visibility: next,
      bundleStatus: next !== 'public' && previousBundleStatus === 'published' ? 'draft' : previousBundleStatus,
    });

    try {
      const result = await requestPostVisibilityChange({ post, visibility: next, accessToken });
      onPatch(post.id, {
        visibility: result.visibility,
        bundleStatus: post.bundle ? result.resourceBundleStatus ?? previousBundleStatus : null,
      });
      pushToast({ tone: 'success', message: VISIBILITY_TOAST[result.visibility] });
      onSettled?.({
        type: 'visibility',
        postId: post.id,
        visibility: result.visibility,
        ownerPath: result.ownerPath,
        showcasePath: result.showcasePath,
      });
      return true;
    } catch (error) {
      onPatch(post.id, { visibility: post.visibility, bundleStatus: previousBundleStatus });
      pushToast({ tone: 'error', message: describeError(error, 'Failed to update post visibility.') });
      return false;
    } finally {
      endAction(post.id);
    }
  }, [accessToken, beginAction, endAction, onAuthRequired, onPatch, onSettled]);

  const archive = useCallback(async (post: PostLifecycleTarget): Promise<boolean> => {
    if (!accessToken) {
      onAuthRequired();
      return false;
    }
    if (post.archivedAt) {
      return false;
    }

    const confirmation = getPostLifecycleConfirmation({ type: 'archive' }, post);
    if (confirmation && !(await requestConfirmation(confirmation))) {
      return false;
    }
    if (!beginAction(post.id, 'archive')) {
      return false;
    }

    const previousBundleStatus = post.bundle?.status ?? null;
    onPatch(post.id, {
      archivedAt: new Date().toISOString(),
      bundleStatus: previousBundleStatus === 'published' ? 'draft' : previousBundleStatus,
    });

    try {
      await requestPostArchive({ postId: post.id, accessToken });
      pushToast({ tone: 'success', message: 'Post archived. Find it under Archived.' });
      onSettled?.({ type: 'archive', postId: post.id });
      return true;
    } catch (error) {
      onPatch(post.id, { archivedAt: null, bundleStatus: previousBundleStatus });
      pushToast({ tone: 'error', message: describeError(error, 'Failed to archive post.') });
      return false;
    } finally {
      endAction(post.id);
    }
  }, [accessToken, beginAction, endAction, onAuthRequired, onPatch, onSettled]);

  const restore = useCallback(async (post: PostLifecycleTarget): Promise<boolean> => {
    if (!accessToken) {
      onAuthRequired();
      return false;
    }
    if (!post.archivedAt) {
      return false;
    }

    const confirmation = getPostLifecycleConfirmation({ type: 'restore' }, post);
    if (confirmation && !(await requestConfirmation(confirmation))) {
      return false;
    }
    if (!beginAction(post.id, 'restore')) {
      return false;
    }

    onPatch(post.id, { archivedAt: null });

    try {
      await requestPostRestore({ postId: post.id, accessToken });
      pushToast({ tone: 'success', message: 'Post restored.' });
      onSettled?.({ type: 'restore', postId: post.id });
      return true;
    } catch (error) {
      onPatch(post.id, { archivedAt: post.archivedAt });
      pushToast({ tone: 'error', message: describeError(error, 'Failed to restore post.') });
      return false;
    } finally {
      endAction(post.id);
    }
  }, [accessToken, beginAction, endAction, onAuthRequired, onPatch, onSettled]);

  const remove = useCallback(async (post: PostLifecycleTarget): Promise<boolean> => {
    if (!accessToken) {
      onAuthRequired();
      return false;
    }

    const confirmation = getPostLifecycleConfirmation({ type: 'delete' }, post);
    if (confirmation && !(await requestConfirmation(confirmation))) {
      return false;
    }
    if (!beginAction(post.id, 'delete')) {
      return false;
    }

    try {
      let result = await requestPostDelete({ postId: post.id, accessToken, force: false });
      if (!result.deleted) {
        // The server found paid buyers. Archive is the safe answer; deleting
        // anyway is the owner's call, asked for a second time with the stakes.
        const forceConfirmed = await requestConfirmation({
          title: 'People have bought this recipe',
          message: 'Archiving keeps the post resolvable for them. Deleting removes it for everyone except existing buyers, who keep their unlock.',
          confirmLabel: 'Delete anyway',
          tone: 'danger',
        });
        if (!forceConfirmed) {
          return false;
        }
        result = await requestPostDelete({ postId: post.id, accessToken, force: true });
        if (!result.deleted) {
          throw new PostLifecycleRequestError('Failed to delete post.', { status: 409 });
        }
      }

      onRemoved?.(post.id);
      pushToast({
        tone: 'success',
        message: result.tombstoned ? 'Post deleted. Buyers keep access to its recipe.' : 'Post deleted.',
      });
      onSettled?.({ type: 'delete', postId: post.id });
      return true;
    } catch (error) {
      pushToast({ tone: 'error', message: describeError(error, 'Failed to delete post.') });
      return false;
    } finally {
      endAction(post.id);
    }
  }, [accessToken, beginAction, endAction, onAuthRequired, onRemoved, onSettled]);

  const pendingAction = useCallback(
    (postId: string): PostLifecycleActionType | null => pending[postId] ?? null,
    [pending],
  );

  return useMemo(
    () => ({ setVisibility, archive, restore, remove, pendingAction }),
    [archive, pendingAction, remove, restore, setVisibility],
  );
}
