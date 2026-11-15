/**
 * A refresh of a page whose address opens a post in its reel (`?post=` on Explore, the profile
 * or a creator's page) drew the page under the reel first: the server's HTML is the grid, and the
 * reel, a chunk of its own, opens only once the page's script has run and fetched it (owner's
 * recording, 2026-11-15: the grid, then the grid dimmed under "Opening preview", then the post).
 *
 * So the root layout marks such an address on the root element before anything is drawn, and the
 * stylesheet covers the page with the reel's own stage until the reel attaches its dialog
 * (`ShowcaseReelViewer`), which takes the mark away (`ReelOpeningCover` gives the page back if the
 * reel never comes). Only a full load runs the script: a tap that opens a reel draws it over the
 * page the reader is looking at. Free of React, as a server component's import must be.
 *
 * The stage shows only while the page holds a reel's host, or the page that will become one
 * still loading: each draws `ReelHostMark`. A page that has no reel to open in the end, a creator
 * not found, one the reader blocked or who blocked them, an error page, a profile that failed to
 * load, draws none, and the page shows as soon as it does (review of #815).
 */

/** On the root element while a reel the address opens is on its way. */
export const REEL_OPENING_ATTRIBUTE = 'data-reel-opening';

/** On an element of a page that opens the address's reel (`ReelHostMark`). */
export const REEL_HOST_ATTRIBUTE = 'data-reel-host';

/** The pages whose `?post=` opens a reel over them: Explore, the profile and a creator's page. */
const REEL_PAGE_PATH = '^/(?:showcase|profile)/?$|^/creators/[^/]+/?$';

/**
 * Whether an address opens a post in its page's reel, as the inline script reads it: a `?post=`
 * with nothing after it opens none.
 */
export function isReelOpeningAddress(pathname: string, search: string): boolean {
  return new RegExp(REEL_PAGE_PATH).test(pathname) && Boolean(new URLSearchParams(search).get('post'));
}

/** Inline in the server's HTML, ahead of the page: the mark, where the address opens a reel. */
export const REEL_OPENING_RESTORE = `try{new RegExp(${JSON.stringify(REEL_PAGE_PATH)}).test(location.pathname)&&new URLSearchParams(location.search).get("post")&&document.documentElement.setAttribute(${JSON.stringify(REEL_OPENING_ATTRIBUTE)},"")}catch(e){}`;

/** The reel is drawn, or is not coming: the page shows as it is. */
export function releaseReelOpening(): void {
  document.documentElement.removeAttribute(REEL_OPENING_ATTRIBUTE);
}
