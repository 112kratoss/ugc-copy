/**
 * The address a click on a link leads to, when the page's own script is the
 * one to act on it: an unmodified primary click on an `<a href>` of this origin
 * that opens in this tab and downloads nothing, which no handler has taken
 * yet. Null for anything the browser handles itself: a new tab, a download,
 * another origin.
 */
export function readInAppLinkClick(event: MouseEvent): URL | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;

  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.hasAttribute('download')) return null;
  if (anchor.target && anchor.target !== '_self') return null;

  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return null;
  }
  return url.origin === window.location.origin ? url : null;
}
