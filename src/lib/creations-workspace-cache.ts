/**
 * Studio keeps what it last read (its creations, posts and profile) in the tab's
 * sessionStorage for a few minutes, so coming back to it draws at once. A post
 * published elsewhere makes that copy stale: the composer forgets it, and Studio
 * reads afresh instead of drawing the creation as not published.
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
