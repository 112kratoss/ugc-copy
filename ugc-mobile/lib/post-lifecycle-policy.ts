/**
 * Which owner actions on a post deserve a confirmation step, and what it says.
 *
 * A copy of the web app's `src/lib/post-lifecycle-policy.ts`, kept in step by
 * hand: the two apps share no package, and the answer must be the same on
 * both so a creator meets the same friction wherever they manage a post.
 * Return `null` for "just do it".
 */

export type PostLifecycleVisibility = 'public' | 'unlisted' | 'private';

export type PostLifecycleAction =
  | { type: 'visibility'; next: PostLifecycleVisibility }
  | { type: 'archive' }
  | { type: 'restore' }
  | { type: 'delete' };

export interface PostLifecycleSubject {
  visibility: PostLifecycleVisibility;
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
      // The one visibility change with a cost worth a pause is taking a post
      // with a listed recipe off public: the recipe leaves the marketplace
      // for as long as the post is not public. It comes back on its own when
      // the post does, so the cost is the time away, not the listing itself.
      // Every other transition is reversible in place or fails loudly (going
      // public runs the quality gate), so it stays one click.
      const leavingPublic = post.visibility === 'public' && action.next !== 'public';
      if (!leavingPublic || post.bundle?.status !== 'published') {
        return null;
      }
      const label = action.next === 'unlisted' ? 'unlisted' : 'private';
      return {
        title: `Make this post ${label}?`,
        message: `Its recipe comes off the marketplace until the post is public again${
          post.bundle.salesCount > 0 ? '; buyers keep their unlock' : ''
        }.`,
        confirmLabel: `Make ${label}`,
      };
    }
  }
}
