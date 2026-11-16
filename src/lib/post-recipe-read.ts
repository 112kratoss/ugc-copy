/**
 * The post page's read of its recipe as the viewer may read it, `GET /api/posts/{id}/resource-bundle`.
 *
 * The route answers 404 where there is no recipe for the viewer (none on the post, not on sale to
 * them, a block), which the app's Details, the reel, the recipe panel and checkout read as "not
 * found". The post page asks it on every post a signed-in reader opens, recipe or not: its cached
 * render is everyone's, so it cannot say whether a recipe is held back for this reader (a buyer
 * keeps a delisted or retired one, the creator their draft). Chrome logged each 404 as a failed
 * load, on every post with no recipe (sweep of 2026-11-17). So the page asks with `absent=none`,
 * and the route answers a recipe it would answer 404 for with 200 and `bundle: null`; every caller
 * that does not ask keeps the 404.
 *
 * Free of server and browser imports: the route and the page both read it.
 */
export const POST_RECIPE_ABSENT_PARAM = 'absent';
export const POST_RECIPE_ABSENT_AS_NONE = 'none';

/** The post page's read of the viewer's recipe, one that is not there for them answered as none. */
export function postRecipeReadPath(postId: string): string {
  return `/api/posts/${encodeURIComponent(postId)}/resource-bundle?${POST_RECIPE_ABSENT_PARAM}=${POST_RECIPE_ABSENT_AS_NONE}`;
}

/** Whether a request to the route asks for a recipe that is not there to be answered as none. */
export function asksAbsentRecipeAsNone(requestUrl: string): boolean {
  try {
    return new URL(requestUrl, 'http://localhost').searchParams.get(POST_RECIPE_ABSENT_PARAM)
      === POST_RECIPE_ABSENT_AS_NONE;
  } catch {
    return false;
  }
}
