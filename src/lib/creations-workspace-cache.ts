/**
 * Studio keeps what it last read (its creations, posts and profile) in the tab's
 * sessionStorage for a few minutes, so coming back to it draws at once. A post
 * published elsewhere makes that copy stale: the composer forgets it, and Studio
 * reads afresh instead of drawing the creation as not published.
 *
 * An edit saved from Studio goes back there and names its post on the way,
 * for Studio to ring the post's card.
 */
export function getCreationsWorkspaceCacheKey(userId: string): string {
  return `magicbooklet:creations-cache:v1:${userId}`;
}

export function forgetCreationsWorkspaceCache(userId: string | null | undefined): void {
  if (!userId || typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.removeItem(getCreationsWorkspaceCacheKey(userId));
  } catch {
    // Storage can be unavailable (a private window); there is then no copy to forget.
  }
}

/** Whether an internal path is Studio's, in any of its views. */
export function isStudioPath(path: string): boolean {
  return path === '/creations' || path.startsWith('/creations?') || path.startsWith('/creations#');
}

// In memory, so it reaches only the Studio this document draws next (the
// editor's Back or replace), never a reload or another tab.
let returnedPostId: string | null = null;

export function rememberStudioReturnedPost(postId: string): void {
  returnedPostId = postId;
}

export function readStudioReturnedPost(): string | null {
  return returnedPostId;
}

export function forgetStudioReturnedPost(): void {
  returnedPostId = null;
}
