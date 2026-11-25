import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useAuth } from './auth';
import { createPostViewLook, type PostViewLook } from './post-view-look';
import { reportPostView, type PostViewSurface } from './post-view-reporter';

/**
 * Reports a post's view each time it is looked at for a second (post view
 * counts, step 3): `onScreen` says whether half of it is on screen, and the
 * second runs only while the app is in front (`createPostViewLook`). For the
 * post page and a reel opened outside the feed; `postId` is null where no
 * view is reported (`viewReportPostId`).
 *
 * A look that qualifies before the session is known (a cold start from a
 * link, while the guest session is being made) is held and reported once it
 * is, so a reader's view never goes under no identity first and theirs after.
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
  // The post whose look qualified while the identity was unknown.
  const heldPostIdRef = useRef<string | null>(null);
  const lookRef = useRef<PostViewLook | null>(null);

  useEffect(() => {
    if (!identity || !postId || heldPostIdRef.current !== postId) return;
    heldPostIdRef.current = null;
    reportPostView({ postId, surface, identity });
  }, [identity, postId, surface]);

  useEffect(() => {
    if (!postId) return undefined;
    heldPostIdRef.current = null;
    const look = createPostViewLook({
      onLooked: () => {
        const context = contextRef.current;
        if (context.identity) {
          reportPostView({ postId, surface: context.surface, identity: context.identity });
        } else {
          heldPostIdRef.current = postId;
        }
      },
    });
    lookRef.current = look;
    look.setForeground(AppState.currentState === 'active');
    look.setOnScreen(contextRef.current.onScreen);
    const subscription = AppState.addEventListener('change', (state) => {
      look.setForeground(state === 'active');
    });
    return () => {
      subscription.remove();
      look.dispose();
      if (lookRef.current === look) lookRef.current = null;
    };
  }, [postId]);

  useEffect(() => {
    lookRef.current?.setOnScreen(onScreen);
  }, [onScreen, postId]);
}
