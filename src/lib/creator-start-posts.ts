import type { HomeShelfCreation } from '@/lib/home-shelf';
import type { RemixTool } from '@/lib/remix-tools';

/**
 * "Start from a post" on the creators' empty canvas, and the posts to watch while a run
 * works (owner, 2026-10-28): the Home shelf's creations, the creator's own tool first,
 * each priced as the remix its Remix opens. A remix opens on its original's model and
 * settings whatever the balance (owner, 2026-11-01), so a video post's card says what that
 * run costs as the page prices it once open; the server prices it ahead
 * (`creator-start-posts-server.ts`), and no balance changes it.
 */

/** A video post's remix, priced as the page prices it once open: on the post's own model and settings. */
export interface StartPostRemixForecast {
  cost: number;
}

export type CreatorStartPost = HomeShelfCreation & { remix: StartPostRemixForecast | null };

/**
 * What a card's Remix costs: the run it opens, on the post's own model. A post without a
 * forecast (an image, a motion, a video whose run the server could not read) keeps the
 * shelf's own price, the one its creator page opens on.
 */
export function startPostRemixCost(post: CreatorStartPost): number | null {
  if (post.remix) return post.remix.cost;
  return post.price?.kind === 'credits' ? post.price.credits : null;
}

/** The creator's own tool first, then the rest, each group in the shelf's order (owner, 2026-10-28). */
export function orderStartPosts<T extends { tool: RemixTool }>(posts: readonly T[], tool: RemixTool): T[] {
  return [...posts.filter((post) => post.tool === tool), ...posts.filter((post) => post.tool !== tool)];
}
