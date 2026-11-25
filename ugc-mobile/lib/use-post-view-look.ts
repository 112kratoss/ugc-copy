import { useEffect, useRef } from 'react';

import { isAppForeground, subscribeToAppForeground } from './app-foreground';
import { useAuth } from './auth';
import { createPostViewLook, type PostViewLook } from './post-view-look';
import { reportPostView, type PostViewSurface } from './post-view-reporter';

/**
 * Reports a post's view each time it is looked at for a second (post view
 * counts, step 3): `onScreen` says whether half of it is on screen, and the
 * second runs only while the app is in front (`createPostViewLook`). For the
 * post page and the reel's slides; `postId` is null where no view is
 * reported (`viewReportPostId`).
 *
 * A look made before the session is known (a cold start from a link, while
 * the stored session is read or the guest one is made) goes to the reporter
 * with no identity, which holds it for the identity the device gets next, so
 * a reader's view never goes under no identity first and theirs after.
 */
export function usePostViewLook({
  postId,
  surface,
  onScreen,
}: {
  postId: string | null;
  surface: PostViewSurface;
  onScreen: boolean;
}) {
  const { identityUserId, isLoading } = useAuth();
  const identity = isLoading ? null : identityUserId;
  // What a view is reported with, kept current for the look's timer without
  // starting the look again. Written after render, read only by the timer.
  const contextRef = useRef({ surface, identity, onScreen });
  useEffect(() => {
    contextRef.current = { surface, identity, onScreen };
  });
  const lookRef = useRef<PostViewLook | null>(null);

  useEffect(() => {
    if (!postId) return undefined;
    const look = createPostViewLook({
      onLooked: () => {
        const context = contextRef.current;
        reportPostView({ postId, surface: context.surface, identity: context.identity });
      },
    });
    lookRef.current = look;
    look.setForeground(isAppForeground());
    look.setOnScreen(contextRef.current.onScreen);
    const unsubscribe = subscribeToAppForeground((foreground) => look.setForeground(foreground));
    return () => {
      unsubscribe();
      look.dispose();
      if (lookRef.current === look) lookRef.current = null;
    };
  }, [postId]);

  useEffect(() => {
    lookRef.current?.setOnScreen(onScreen);
  }, [onScreen, postId]);
}
