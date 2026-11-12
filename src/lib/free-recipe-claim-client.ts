import { trackProductEvent } from '@/lib/product-analytics';

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
    throw new Error(typeof data?.error === 'string' && data.error ? data.error : 'Failed to get the free recipe.');
  }
  trackProductEvent('recipe_unlock_succeeded', { method: 'free', post_id: postId });
}
