import type { PostVisibility } from '@/lib/post-lifecycle-client';

/**
 * Which owner actions on a post deserve a confirmation step, and what it says.
 *
 * This is product policy, kept apart from the request code and the UI so the
 * same answer applies on every surface (Studio cards, the detail page) and
 * can be read in one place. Return `null` for "just do it".
 */

export type PostLifecycleAction =
  | { type: 'visibility'; next: PostVisibility }
  | { type: 'archive' }
  | { type: 'restore' }
  | { type: 'delete' };

export interface PostLifecycleSubject {
  visibility: PostVisibility;
  archivedAt: string | null;
  bundle: {
    accessMode: 'free' | 'paid';
    status: 'draft' | 'published';
    /** Completed paid orders. A sold bundle is frozen server-side. */
    salesCount: number;
  } | null;
}

export interface PostLifecycleConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  /** `danger` styles the confirm button as destructive. */
  tone?: 'default' | 'danger';
}

export function getPostLifecycleConfirmation(
  action: PostLifecycleAction,
  post: PostLifecycleSubject,
): PostLifecycleConfirmation | null {
  switch (action.type) {
    case 'archive':
      return {
        title: 'Archive this post?',
        message: 'It will disappear from public surfaces until you restore it.',
        confirmLabel: 'Archive',
      };

    case 'restore':
      return null;

    case 'delete':
      return {
        title: 'Delete this post permanently?',
        message: post.bundle && post.bundle.salesCount > 0
          ? 'People have bought its recipe. Archive keeps it resolvable for them; you will be asked again before a forced delete.'
          : 'This cannot be undone.',
        confirmLabel: 'Delete',
        tone: 'danger',
      };

    case 'visibility': {
      // TODO(athul): decide which visibility changes deserve friction.
      //
      // What the server does on each transition, so the copy can be honest:
      //   → private / unlisted from public: the post leaves the showcase and
      //     the feed; a published recipe is demoted to `draft` and its
      //     marketplace listing is set to `unlisted`. Buyers keep access.
      //   → public: the post must pass the public quality gate and the
      //     creator-profile check (the request can fail with a reason).
      //     A demoted recipe is NOT re-promoted by this flip; the editor's
      //     full save is what republishes it.
      //   → unlisted: reachable by link only. Reversible and quiet.
      //
      // Inputs available: `action.next`, `post.visibility`, `post.bundle`
      // (accessMode, status, salesCount). Return null for one-click, or a
      // confirmation with honest copy. Keep it to the transitions where a
      // wrong click costs the creator something.
      return null;
    }
  }
}
