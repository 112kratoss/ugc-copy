import type { QueryClient } from '@tanstack/react-query';

import type { HomeShelfResponse } from './types';

/**
 * Home's "Make this" shelf (`['home-shelf', identity]`) after the viewer takes
 * a creator or a post out of what they see: a block, a Hide, a Not interested
 * or a report, from any screen. The server leaves them off the shelf as the
 * feed does, but the shelf's answer is kept for five minutes on a tab that
 * stays mounted, so the card would stay on screen and its remix would be
 * refused. The card goes at once; the answer is marked stale, not read again
 * now, so the block's own screen moves on before anything is fetched (as the
 * feed caches do), and the next read comes from the server.
 */
export function takeOffHomeShelf(
  queryClient: Pick<QueryClient, 'setQueriesData' | 'invalidateQueries'>,
  target: { creatorId?: string | null; postId?: string | null },
) {
  queryClient.setQueriesData<HomeShelfResponse>({ queryKey: ['home-shelf'] }, (current) => (
    current
      ? {
          ...current,
          items: current.items.filter((item) => (
            item.kind !== 'creation'
            || !(
              (target.postId && item.post.id === target.postId)
              || (target.creatorId && item.post.creator.id === target.creatorId)
            )
          )),
        }
      : current
  ));
  void queryClient.invalidateQueries({ queryKey: ['home-shelf'], refetchType: 'none' });
}

/** A creator unblocked, or a Hide taken back: the shelf may draw them again, so it is asked again. */
export function refreshHomeShelf(queryClient: Pick<QueryClient, 'invalidateQueries'>) {
  void queryClient.invalidateQueries({ queryKey: ['home-shelf'] });
}
