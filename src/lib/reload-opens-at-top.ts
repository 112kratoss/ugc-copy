/**
 * A refresh of Home, Explore or Marketplace opens at the page's top (owner's recording, 2026-11-16).
 * Each starts afresh on a reload: Home and Explore rank a new feed, and Marketplace draws its first
 * page alone (`marketplace-pages-memory.ts`). The browser still put the old scroll offset back:
 * on Home the skeleton and the first rows drew at the top, then the page jumped down onto a post
 * the reader had never scrolled to; on Marketplace it landed at the bottom of the short first page.
 *
 * Chrome decides a reload's restore from the mode the history entry carries in from the page that
 * left it, and keeps trying until the load event: a `history.scrollRestoration = 'manual'` written
 * by the new document is too late for a page already tall at its first layout (measured
 * 2026-11-16, `archive/home-reload-opens-at-top-2026-11-16/`). So these pages mark their entry
 * `manual` as the document goes (`pagehide`), and the next document on that entry gives the
 * restore back:
 *
 * - after a reload, on the task after its load event, once the browser has stopped trying. Not
 *   sooner: a mode given back at DOMContentLoaded still let the restore land at the load event.
 * - after a Back or Forward from another document, at once: Home and Explore draw the grid they
 *   kept from that visit, and the browser still puts the reader back where it was left.
 *
 * A reloaded document on one of these pages also turns the restore off itself as it starts, for a
 * reload no `pagehide` came before: a tab the browser discarded in the background and reloads when
 * it is shown again (review of #832). That alone stops a restore only for content that comes after
 * the first layout, as a streamed feed does, which is why it is the backstop and not the rule.
 *
 * Given back, because a mode left `manual` would spread: every entry the app pushes takes the
 * current entry's mode, and Back inside the app would stop returning to where a page was left.
 * Entries pushed before a reload's load ended took `manual` with them, so a Back or Forward after
 * the load gives each one back as it is reached; one brought back whole from the back-forward cache
 * is as it was left, and gets it back at once.
 *
 * Only a full load runs it, from the root layout. Free of React, as a server component's import
 * must be.
 */

/**
 * The pages a refresh starts at the top: Home (`/`), Explore's grid and Marketplace's listing,
 * whatever their query holds. A post, a creator's page or a recipe keeps its place, as anywhere else.
 */
export const RELOAD_OPENS_AT_TOP_PATHNAMES = ['/', '/showcase', '/marketplace'] as const;

/** Inline in the server's HTML, ahead of the page. */
export const RELOAD_OPENS_AT_TOP = `try{if("scrollRestoration"in history){var p=${JSON.stringify(RELOAD_OPENS_AT_TOP_PATHNAMES)},g=function(){history.scrollRestoration==="manual"&&(history.scrollRestoration="auto")},l=function(){return document.readyState==="complete"},n=performance.getEntriesByType&&performance.getEntriesByType("navigation")[0];n&&n.type==="reload"&&p.indexOf(location.pathname)>-1&&(history.scrollRestoration="manual");if(history.scrollRestoration==="manual"){if(n&&n.type==="back_forward")g();else l()?setTimeout(g,0):addEventListener("load",function(){setTimeout(g,0)},{once:true})}addEventListener("pagehide",function(){p.indexOf(location.pathname)>-1&&(history.scrollRestoration="manual")});addEventListener("pageshow",function(e){e.persisted&&g()});addEventListener("popstate",function(){l()&&g()})}}catch(e){}`;
