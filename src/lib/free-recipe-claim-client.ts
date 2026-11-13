import { trackProductEvent } from '@/lib/product-analytics';
import { forgetKeptSearchPages } from '@/lib/search-kept-pages';

/**
 * Takes a post's free recipe for the viewer, as the post page's recipe panel
 * and the reel do, with their funnel events: a recipe got from a Home card or
 * from the post page's Remix counts as one got there. Throws the server's
 * reason, so the surface that asked can say it.
 */
export async function claimFreeRecipe(postId: string, accessToken: string) {
  trackProductEvent('recipe_unlock_started', { method: 'free', post_id: postId });
  const response = await fetch(`/api/posts/${postId}/resource-bundle/unlock-free`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => null);
  if (!response?.ok) {
    const data = await response?.json().catch(() => null) as { error?: unknown } | null | undefined;
    trackProductEvent('recipe_unlock_failed', { method: 'free', post_id: postId });
    // With the answer's status (none for a failed network), which tells a recipe that cannot be
    // taken from a claim a later try can make (`remixReadMaySucceedLater`).
    throw Object.assign(
      new Error(typeof data?.error === 'string' && data.error ? data.error : 'Failed to get the free recipe.'),
      { status: response?.status },
    );
  }
  trackProductEvent('recipe_unlock_succeeded', { method: 'free', post_id: postId });
  // A search Back would redraw from what it kept says the recipe is not the viewer's yet.
  forgetKeptSearchPages();
}
