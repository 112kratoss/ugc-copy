/**
 * The root element's mark where this browser's scrollbars take room beside the page (a mouse on
 * Windows or Linux, a Mac set to always show them), set before the first paint: `globals.css` then
 * keeps the window's scrollbar room open whether the page scrolls or not (`scrollbar-gutter:
 * stable`), and a scrollbar coming or going never moves the page. Alerts, whose list comes after its
 * first paint, moved 7.5px sideways when its scrollbar came (sweep of 2026-11-17, a layout shift of
 * 0.0054); every page moved going between a short page and a long one; and the page under a dialog
 * that stops it scrolling moved as the dialog opened.
 *
 * Scrollbars laid over the page (phones, a Mac's default) take no room and get no mark, so nothing
 * changes there. Measured, not assumed: a stylesheet cannot tell the two kinds apart, and a gutter
 * kept for scrollbars that take no room would narrow the page for nothing (headless Chromium, which
 * hides its scrollbars, kept 15px open on every page).
 */
export const SCROLLBAR_ROOM_ATTRIBUTE = 'data-scrollbar-room';

/**
 * Inline in the server's HTML, ahead of the shell: a box that always scrolls, out of view, measured
 * once and taken out again. Its scrollbar's room is its outer width less its inner one.
 */
export const SCROLLBAR_ROOM_RESTORE = `try{var s=document.createElement("div");s.style.cssText="position:absolute;top:-9999px;left:0;width:100px;height:100px;overflow:scroll;visibility:hidden";(document.body||document.documentElement).appendChild(s);s.offsetWidth-s.clientWidth>0&&document.documentElement.setAttribute(${JSON.stringify(SCROLLBAR_ROOM_ATTRIBUTE)},"");s.remove()}catch(e){}`;
