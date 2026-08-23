import { Alert } from 'react-native';

import { ApiError, type MagicbookletApiClient } from './api-client';
import {
  getPostLifecycleConfirmation,
  type PostLifecycleConfirmation,
  type PostLifecycleSubject,
  type PostLifecycleVisibility,
} from './post-lifecycle-policy';
import type { OwnerPostBundleSummary } from './types';

/**
 * Visibility, archive, restore, and delete for posts the viewer owns — one
 * flow for every owner surface (the profile feed, the viewer's More sheet,
 * the text post page): ask when policy says so, call the post route, and
 * report a failure with the server's reason rather than a generic retry.
 *
 * The three surfaces used to carry their own copies, which is how a selling
 * recipe could be taken off public without a word from one of them while
 * another asked before every toggle.
 */

export type PostLifecycleOutcome = 'done' | 'cancelled' | 'failed';

export interface PostLifecyclePost extends PostLifecycleSubject {
  id: string;
}

type Confirm = (confirmation: PostLifecycleConfirmation) => Promise<boolean>;

export const POST_VISIBILITY_OPTIONS: ReadonlyArray<{ value: PostLifecycleVisibility; label: string }> = [
  { value: 'public', label: 'Public' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'private', label: 'Private' },
];

export function normalizePostLifecycleVisibility(value: string | null | undefined): PostLifecycleVisibility {
  return value === 'public' || value === 'unlisted' ? value : 'private';
}

/** The policy's view of a post, from whichever record a surface holds. */
export function toPostLifecyclePost(input: {
  id: string;
  visibility?: string | null;
  archivedAt?: string | null;
  bundle?: Pick<OwnerPostBundleSummary, 'accessMode' | 'status' | 'salesCount'> | null;
}): PostLifecyclePost {
  const bundle = input.bundle ?? null;
  return {
    id: input.id,
    visibility: normalizePostLifecycleVisibility(input.visibility),
    archivedAt: input.archivedAt ?? null,
    bundle: bundle
      ? {
          accessMode: bundle.accessMode,
          status: bundle.status === 'published' ? 'published' : 'draft',
          salesCount: bundle.salesCount ?? 0,
        }
      : null,
  };
}

/** Native confirmation for a policy decision. */
export function confirmPostLifecycleAction(confirmation: PostLifecycleConfirmation): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(confirmation.title, confirmation.message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      {
        text: confirmation.confirmLabel,
        style: confirmation.tone === 'danger' ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/** The three-state picker every surface offers. */
export function pickPostVisibility(
  current: PostLifecycleVisibility,
  onPick: (next: PostLifecycleVisibility) => void,
) {
  Alert.alert('Change visibility', 'Choose who can see this post.', [
    ...POST_VISIBILITY_OPTIONS.map((option) => ({
      text: option.value === current ? `${option.label} (current)` : option.label,
      onPress: () => {
        if (option.value !== current) onPick(option.value);
      },
    })),
    { text: 'Cancel', style: 'cancel' as const },
  ]);
}

export function describePostLifecycleError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function reportFailure(title: string, error: unknown, fallback: string) {
  Alert.alert(title, describePostLifecycleError(error, fallback));
}

export function isForceDeleteRequired(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 409
    && typeof error.details === 'object'
    && error.details !== null
    && (error.details as Record<string, unknown>).requiresForceDelete === true;
}

export async function changePostVisibility({
  api,
  post,
  visibility,
  confirm = confirmPostLifecycleAction,
}: {
  api: Pick<MagicbookletApiClient, 'updatePost'>;
  post: PostLifecyclePost;
  visibility: PostLifecycleVisibility;
  confirm?: Confirm;
}): Promise<PostLifecycleOutcome> {
  if (post.archivedAt || visibility === post.visibility) {
    return 'cancelled';
  }
  const confirmation = getPostLifecycleConfirmation({ type: 'visibility', next: visibility }, post);
  if (confirmation && !(await confirm(confirmation))) {
    return 'cancelled';
  }
  try {
    await api.updatePost(post.id, { visibility });
    return 'done';
  } catch (error) {
    reportFailure('Could not update visibility', error, 'Please try again.');
    return 'failed';
  }
}

export async function archivePost({
  api,
  post,
  confirm = confirmPostLifecycleAction,
}: {
  api: Pick<MagicbookletApiClient, 'archivePost'>;
  post: PostLifecyclePost;
  confirm?: Confirm;
}): Promise<PostLifecycleOutcome> {
  if (post.archivedAt) {
    return 'cancelled';
  }
  const confirmation = getPostLifecycleConfirmation({ type: 'archive' }, post);
  if (confirmation && !(await confirm(confirmation))) {
    return 'cancelled';
  }
  try {
    await api.archivePost(post.id);
    return 'done';
  } catch (error) {
    reportFailure('Could not archive post', error, 'Please try again.');
    return 'failed';
  }
}

export async function restorePost({
  api,
  post,
  confirm = confirmPostLifecycleAction,
}: {
  api: Pick<MagicbookletApiClient, 'restorePost'>;
  post: PostLifecyclePost;
  confirm?: Confirm;
}): Promise<PostLifecycleOutcome> {
  if (!post.archivedAt) {
    return 'cancelled';
  }
  const confirmation = getPostLifecycleConfirmation({ type: 'restore' }, post);
  if (confirmation && !(await confirm(confirmation))) {
    return 'cancelled';
  }
  try {
    await api.restorePost(post.id);
    return 'done';
  } catch (error) {
    reportFailure('Could not restore post', error, 'Please try again.');
    return 'failed';
  }
}

export async function deletePost({
  api,
  post,
  confirm = confirmPostLifecycleAction,
}: {
  api: Pick<MagicbookletApiClient, 'deletePost'>;
  post: PostLifecyclePost;
  confirm?: Confirm;
}): Promise<PostLifecycleOutcome> {
  const confirmation = getPostLifecycleConfirmation({ type: 'delete' }, post);
  if (confirmation && !(await confirm(confirmation))) {
    return 'cancelled';
  }
  try {
    await api.deletePost(post.id);
    return 'done';
  } catch (error) {
    if (!isForceDeleteRequired(error)) {
      reportFailure('Could not delete post', error, 'Please try again.');
      return 'failed';
    }
  }

  // The server found paid buyers. Archive is the safe answer; deleting anyway
  // is the owner's call, asked a second time with the stakes.
  const forceConfirmed = await confirm({
    title: 'People have bought this recipe',
    message: 'Archiving keeps the post resolvable for them. Deleting removes it for everyone except existing buyers, who keep their unlock.',
    confirmLabel: 'Delete anyway',
    tone: 'danger',
  });
  if (!forceConfirmed) {
    return 'cancelled';
  }
  try {
    await api.deletePost(post.id, { force: true });
    return 'done';
  } catch (error) {
    reportFailure('Could not delete post', error, 'Please try again.');
    return 'failed';
  }
}
