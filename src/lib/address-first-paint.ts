import { FEED_CHIPS } from '@/lib/post-feed-chips';

/**
 * A choice kept in the address, drawn from the first paint on a page drawn ahead of time.
 *
 * Signed-out Home, a creator's page and Templates are drawn once for everyone, with their
 * defaults: For you, Posts, All formats. A refresh on `/?chip=notes`,
 * `/creators/<name>#creator-unlocks` or `/templates?input=image` showed the default until the
 * page's script ran, then switched (owner, 2026-11-15: "fix the … refresh flash too").
 *
 * So the root layout marks the address's choice on the root element before anything is drawn,
 * and globals.css draws it from that mark: the chip or tab chosen, and the cards it leaves out.
 * The page takes the mark away once it draws the same choice itself (`useFirstPaintMark`), and
 * the shell takes it away if the reader goes to another page (`AddressFirstPaintRelease`). Only
 * a full load runs the script; on a navigation the page reads the address in its first render.
 * Free of React, as a server component's import must be.
 */

/** The lane `?chip=` names on Home (For you, the default, is never marked). */
export const HOME_CHIP_MARK = 'data-home-chip';
/** The creator page's tab the address's fragment names (Posts, the default, is never marked). */
export const CREATOR_TAB_MARK = 'data-creator-tab';
/** The media filter `?input=` names on Templates (All formats, the default, is never marked). */
export const TEMPLATE_INPUT_MARK = 'data-template-input';

export const ADDRESS_FIRST_PAINT_MARKS = [HOME_CHIP_MARK, CREATOR_TAB_MARK, TEMPLATE_INPUT_MARK] as const;

/** Home's lanes but its first, For you. */
const HOME_MARKED_LANES = FEED_CHIPS.slice(1).map((chip) => chip.id as string);

/** The creator page's tabs as the address's fragment names them (`CreatorContentTabs`). */
export const CREATOR_TAB_HASHES = {
  creations: '#creator-creations',
  unlocks: '#creator-unlocks',
  tools: '#creator-tools',
} as const;
export type CreatorTab = keyof typeof CREATOR_TAB_HASHES;
const CREATOR_MARKED_TABS: Record<string, CreatorTab> = {
  [CREATOR_TAB_HASHES.unlocks]: 'unlocks',
  [CREATOR_TAB_HASHES.tools]: 'tools',
};

/** Templates' media filters `?input=` may name; All formats is left unsaid. */
export const TEMPLATE_INPUT_FILTERS = ['image', 'video'] as const;
export type TemplateInputFilter = (typeof TEMPLATE_INPUT_FILTERS)[number];

const HOME_PATH = '^/$';
const CREATOR_PATH = '^/creators/[^/]+/?$';
const TEMPLATES_PATH = '^/templates/?$';

/** The mark an address gives its page, as the inline script reads it; null where it gives none. */
export function readAddressFirstPaintMark(
  pathname: string,
  search: string,
  hash: string,
): { attribute: string; value: string } | null {
  const params = new URLSearchParams(search);
  if (new RegExp(HOME_PATH).test(pathname)) {
    const lane = params.get('chip');
    return lane && HOME_MARKED_LANES.includes(lane) ? { attribute: HOME_CHIP_MARK, value: lane } : null;
  }
  if (new RegExp(CREATOR_PATH).test(pathname)) {
    const tab = Object.prototype.hasOwnProperty.call(CREATOR_MARKED_TABS, hash) ? CREATOR_MARKED_TABS[hash] : null;
    return tab ? { attribute: CREATOR_TAB_MARK, value: tab } : null;
  }
  if (new RegExp(TEMPLATES_PATH).test(pathname)) {
    const input = params.get('input');
    return input && (TEMPLATE_INPUT_FILTERS as readonly string[]).includes(input)
      ? { attribute: TEMPLATE_INPUT_MARK, value: input }
      : null;
  }
  return null;
}

/** Inline in the server's HTML, ahead of the page: the mark the address gives it. */
export const ADDRESS_FIRST_PAINT_RESTORE = [
  'try{var r=document.documentElement,p=location.pathname,q=new URLSearchParams(location.search),v=null,a=null;',
  `if(new RegExp(${JSON.stringify(HOME_PATH)}).test(p)){v=q.get("chip");if(${JSON.stringify(HOME_MARKED_LANES)}.indexOf(v)>=0)a=${JSON.stringify(HOME_CHIP_MARK)}}`,
  `else if(new RegExp(${JSON.stringify(CREATOR_PATH)}).test(p)){var t=${JSON.stringify(CREATOR_MARKED_TABS)};`,
  `if(Object.prototype.hasOwnProperty.call(t,location.hash)){v=t[location.hash];a=${JSON.stringify(CREATOR_TAB_MARK)}}}`,
  `else if(new RegExp(${JSON.stringify(TEMPLATES_PATH)}).test(p)){v=q.get("input");if(${JSON.stringify(TEMPLATE_INPUT_FILTERS)}.indexOf(v)>=0)a=${JSON.stringify(TEMPLATE_INPUT_MARK)}}`,
  'if(a)r.setAttribute(a,v)}catch(e){}',
].join('');

/** The page has drawn the choice itself, or the reader has gone to another page. */
export function releaseAddressFirstPaintMark(attribute: string): void {
  document.documentElement.removeAttribute(attribute);
}
