/**
 * A refresh of Home opens at its top (owner's recording, 2026-11-16). Home's feed is ranked afresh
 * on every load, but the browser put the old scroll offset back on the new feed: the skeleton and
 * the first rows drew at the top, then the page jumped down onto a post the reader had never
 * scrolled to.
 *
 * Chrome decides a reload's restore from the mode the history entry carries in from the page that
 * left it, and keeps trying until the load event: a `history.scrollRestoration = 'manual'` written
 * by the new document is too late for a page already tall at its first layout (measured
 * 2026-11-16, `archive/home-reload-opens-at-top-2026-11-16/`). So Home marks its entry `manual`
 * as the document goes (`pagehide`: a refresh, or a full page load away from Home), and the next
 * document on that entry gives the browser its restore back once its load is done. Only then: a
 * mode given back at DOMContentLoaded still let the restore land at the load event.
 *
 * Given back, because a mode left `manual` would spread: every entry the app pushes takes the
 * current entry's mode, and Back inside the app would stop returning to where a page was left.
 * Entries pushed before the load ended took `manual` with them, so a Back or Forward after the load
 * gives each one back as it is reached; one brought back whole from the back-forward cache is as
 * it was left, and gets it back at once.
 *
 * Only a full load runs it, from the root layout. Free of React, as a server component's import
 * must be.
 */

/** The address Home is drawn at: `/`, a lane in its query included (`/?chip=recent`). */
export const HOME_PATHNAME = '/';

/** Inline in the server's HTML, ahead of the page. */
export const HOME_RELOAD_AT_TOP = `try{if("scrollRestoration"in history){var g=function(){history.scrollRestoration==="manual"&&(history.scrollRestoration="auto")},l=function(){return document.readyState==="complete"};history.scrollRestoration==="manual"&&(l()?setTimeout(g,0):addEventListener("load",function(){setTimeout(g,0)},{once:true}));addEventListener("pagehide",function(){location.pathname===${JSON.stringify(HOME_PATHNAME)}&&(history.scrollRestoration="manual")});addEventListener("pageshow",function(e){e.persisted&&g()});addEventListener("popstate",function(){l()&&g()})}}catch(e){}`;
