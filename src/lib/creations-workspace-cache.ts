import type { CreationMediaFilter, StudioPostFilter } from '@/lib/creation-workspace';

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

export type StudioWorkspaceView = 'creations' | 'posts' | 'unlocks';

/** Studio's section as its address names it: Creations when it names none. */
export function parseStudioWorkspaceView(value: string | null): StudioWorkspaceView {
  return value === 'posts' || value === 'unlocks' ? value : 'creations';
}

/** Post Library's visibility filter as the address names it: All when none. */
export function parseStudioPostFilter(value: string | null): StudioPostFilter {
  return value === 'public' || value === 'unlisted' || value === 'private' || value === 'archived'
    ? value
    : 'all';
}

/** The creations' media filter as the address names it: All when none. */
export function parseCreationMediaFilter(value: string | null): CreationMediaFilter {
  return value === 'images' || value === 'videos' || value === 'audio' ? value : 'all';
}

/**
 * Whether two addresses are the same Studio view as Studio reads them: the
 * same section and filters, whatever a default left out or a link added (the
 * run an alert opened). An edit saved from Studio steps back onto such an
 * entry rather than put a second Studio behind it (#930's review).
 */
export function isSameStudioView(a: URL, b: URL): boolean {
  if (a.origin !== b.origin || a.pathname !== '/creations' || b.pathname !== '/creations') return false;
  return parseStudioWorkspaceView(a.searchParams.get('view')) === parseStudioWorkspaceView(b.searchParams.get('view'))
    && parseStudioPostFilter(a.searchParams.get('visibility')) === parseStudioPostFilter(b.searchParams.get('visibility'))
    && parseCreationMediaFilter(a.searchParams.get('media')) === parseCreationMediaFilter(b.searchParams.get('media'));
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
