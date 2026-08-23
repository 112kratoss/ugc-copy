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
      // The only visibility change with a hidden, one-way cost is taking a
      // post with a listed recipe off public: the server demotes the recipe
      // to draft and unlists its marketplace asset, and making the post
      // public again does not relist it — only a full save from the editor
      // does. Every other transition is either reversible in place or fails
      // loudly (going public runs the quality gate), so it stays one click.
      const leavingPublic = post.visibility === 'public' && action.next !== 'public';
      if (!leavingPublic || post.bundle?.status !== 'published') {
        return null;
      }
      const label = action.next === 'unlisted' ? 'unlisted' : 'private';
      return {
        title: `Make this post ${label}?`,
        message: `Its recipe comes off the marketplace and goes back to draft${
          post.bundle.salesCount > 0 ? '; buyers keep their unlock' : ''
        }. Making the post public again does not relist it — save it from the editor to relist.`,
        confirmLabel: `Make ${label}`,
      };
    }
  }
}
