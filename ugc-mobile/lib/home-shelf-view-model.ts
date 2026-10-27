import { formatCreditCost } from './generation-action-label';
import { SHOWCASE_PLAYBACK_VIEWABILITY } from './showcase-feed-events';
import type { ToolAccent } from './theme';
import type {
  HomeShelfAction,
  HomeShelfCreation,
  HomeShelfItem,
  HomeShelfPrice,
  HomeShelfResponse,
  ShowcaseFeedItem,
} from './types';
import { getNativeRemixCreateHref } from './viewer-actions';

/**
 * Home's "Make this" shelf, as the app draws it: what the server sent
 * (`GET /api/home/shelf`), in words. The web draws the same shelf from
 * `src/components/HomeShelf.tsx` with `src/lib/home-shelf-copy.ts`; the words
 * both say are pinned to one answer by `contracts/mobile-api-v1.json`
 * (`getHomeShelf.copy`).
 */

// Two decimals, as Invite and every other referral surface prints the terms:
// they are basis points over 100, and 725 bps is 7.25%, never "7.3%".
const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const ACTION_IDS: ReadonlySet<string> = new Set<HomeShelfAction['id']>(['post', 'invite', 'earn']);
const CREATION_TOOLS: ReadonlySet<string> = new Set<HomeShelfCreation['tool']>(['image', 'video', 'motion']);

/**
 * The server's floor (`HOME_SHELF_MIN_CREATIONS`, `src/lib/home-shelf.ts`):
 * two cards and an offer read as a broken row. The app applies it again once
 * it has taken cards off itself (`home-shelf-cache.ts`).
 */
const HOME_SHELF_MIN_CREATIONS = 3;

/**
 * The items this build knows how to draw, in the server's order. A newer
 * server may add a kind of card; an older app skips it rather than drawing it
 * wrong, and a creation without a post to remix is skipped too. Too few
 * creations left, and there is no shelf: the row shows the tools instead.
 */
export function readHomeShelfItems(response: HomeShelfResponse | null | undefined): HomeShelfItem[] {
  if (!response || !Array.isArray(response.items)) return [];

  const items = response.items.filter((item): item is HomeShelfItem => {
    if (!item || typeof item !== 'object') return false;
    if (item.kind === 'action') return ACTION_IDS.has(item.id);
    if (item.kind === 'creation') {
      return CREATION_TOOLS.has(item.tool) && Boolean(item.posterUrl) && Boolean(item.post?.id);
    }
    return false;
  });
  const creations = items.filter((item) => item.kind === 'creation').length;
  return creations >= HOME_SHELF_MIN_CREATIONS ? items : [];
}

/**
 * Where a guest's "Make this" lands once they have signed in: this remix's
 * editor (the web's create link, as the app's route, as the web's own card
 * carries it through sign-in), or the post when the card has no such link.
 */
export function homeShelfGuestReturnTo(creation: HomeShelfCreation): string {
  const href = creation.makeHref
    ? getNativeRemixCreateHref({ redirectTo: creation.makeHref, recreateTool: creation.tool })
    : null;
  return href?.includes('remix=') ? href : `/post/${creation.post.id}`;
}

/** "15 credits" in the words the Generate button uses, "Priced by clip length", or nothing. */
export function formatHomeShelfPrice(price: HomeShelfPrice | null): string | null {
  if (!price) return null;
  if (price.kind === 'clip-length') return 'Priced by clip length';
  return formatCreditCost(price.credits);
}

/**
 * One badge at most: a launch outranks the welcome credits, and "Free to try"
 * is said only to someone still owed them (signed out, or a guest).
 */
export function homeShelfBadge(
  creation: Pick<HomeShelfCreation, 'badge' | 'fitsWelcomeCredits'>,
  offerFreeToTry: boolean,
): string | null {
  if (creation.badge === 'new-model') return 'New model';
  return offerFreeToTry && creation.fitsWelcomeCredits ? 'Free to try' : null;
}

/** "@handle", or the display name for a creator without one. */
export function homeShelfCreatorLabel(creator: HomeShelfCreation['creator']): string | null {
  return creator.username ? `@${creator.username}` : creator.name;
}

/**
 * What a screen reader says for a creation card, in reading order: its badge
 * (`homeShelfBadge`) too, which the web's card has in its link text.
 */
export function homeShelfCreationLabel(creation: HomeShelfCreation, badge: string | null = null): string {
  const handle = homeShelfCreatorLabel(creation.creator);
  return [
    creation.title,
    badge,
    creation.modelName,
    formatHomeShelfPrice(creation.price),
    handle ? `by ${handle}` : null,
  ].filter(Boolean).join(', ');
}

/** What a press on a creation card does, for a screen reader: a guest signs in first. */
export function homeShelfCreationHint(signsInFirst: boolean): string {
  return signsInFirst
    ? 'Opens sign-in, then the creator with this prompt and settings'
    : 'Opens the creator with this prompt and settings';
}

/**
 * The poster's cache identity: the feed's own key for the same media, so a
 * pinned post that is also in the feed is fetched and stored once.
 */
export function homeShelfPosterCacheKey(creation: HomeShelfCreation): string {
  const lead = (creation.post.mediaItems ?? []).slice().sort((left, right) => left.sortOrder - right.sortOrder)[0];
  return lead?.previewCacheKey ?? creation.posterUrl;
}

/** How much of a card counts as in view: the feed's own playback threshold. */
const IN_VIEW = SHOWCASE_PLAYBACK_VIEWABILITY.itemVisiblePercentThreshold / 100;

/** Whether at least `IN_VIEW` of the span from `start`, `length` long, lies between `viewStart` and `viewEnd`. */
function mostlyInView(start: number, length: number, viewStart: number, viewEnd: number) {
  if (!(length > 0)) return false;
  return (Math.min(start + length, viewEnd) - Math.max(start, viewStart)) / length >= IN_VIEW;
}

/**
 * The id a shelf card plays under in Home's one-clip election
 * (`lib/home-feed-playback.ts`). Never the feed card's own: the same post can
 * be on the shelf and in the feed, and the two tiles must not answer to one
 * activation.
 */
export function homeShelfPlaybackId(creation: Pick<HomeShelfCreation, 'post'>): string {
  return `home-shelf:${creation.post.id}`;
}

/**
 * What the shelf puts up for Home's one playing clip: the first card with a
 * clip that is mostly in the row's view, as a feed item under the shelf's own
 * id, or null. Cards whose clip failed (`failedIds`, by that id) are passed
 * over, so the slot goes on to a clip that plays. Every card, offers included,
 * sits `cardWidth + gap` after the one before it, the first at `leading`, and
 * the row ends in the Start from scratch tile. `scrollX` is where the row last
 * came to rest, held to where the row can still be: one that has since lost
 * cards was pulled back by the scroll view without a word.
 */
export function selectHomeShelfPlaybackCandidate(
  items: HomeShelfItem[],
  row: { scrollX: number; viewportWidth: number; cardWidth: number; gap: number; leading: number },
  failedIds: readonly string[] = [],
): ShowcaseFeedItem | null {
  if (!(row.cardWidth > 0) || !(row.viewportWidth > 0)) return null;
  const contentWidth = row.leading * 2 + (items.length + 1) * row.cardWidth + items.length * row.gap;
  const viewStart = Math.min(Math.max(row.scrollX, 0), Math.max(0, contentWidth - row.viewportWidth));
  const viewEnd = viewStart + row.viewportWidth;
  for (const [index, item] of items.entries()) {
    if (item.kind !== 'creation' || !item.clipUrl) continue;
    const id = homeShelfPlaybackId(item);
    if (failedIds.includes(id)) continue;
    const start = row.leading + index * (row.cardWidth + row.gap);
    if (mostlyInView(start, row.cardWidth, viewStart, viewEnd)) return { ...item.post, id };
  }
  return null;
}

/** Whether a box at `top` (window points, `height` tall) is mostly on a screen `windowHeight` tall. */
export function isHomeShelfInView(top: number, height: number, windowHeight: number): boolean {
  return mostlyInView(top, height, 0, windowHeight);
}

export type HomeShelfActionIcon = 'send' | 'gift' | 'coins';

export interface HomeShelfActionCopy {
  title: string;
  body: string;
  cta: string;
  route: string;
  accent: ToolAccent;
  icon: HomeShelfActionIcon;
}

export function homeShelfActionCopy(action: HomeShelfAction): HomeShelfActionCopy {
  if (action.id === 'post') {
    return {
      title: 'Share your first post',
      body: 'Post a creation or a tip to the feed.',
      cta: 'Post now',
      route: '/post/new',
      accent: 'primary',
      icon: 'send',
    };
  }

  if (action.id === 'earn') {
    return {
      title: 'Earn from your prompts',
      body: `Add a recipe to a post, set a price, and keep ${percent.format(action.creatorSharePercent)}% of each sale.`,
      cta: 'Start selling',
      route: '/seller-dashboard',
      accent: 'workflow',
      icon: 'coins',
    };
  }

  const yours = action.inviterPercent > 0
    ? `You get ${percent.format(action.inviterPercent)}% of their top-ups in credits.`
    : '';
  const theirs = action.inviteePercent > 0
    ? `They get ${percent.format(action.inviteePercent)}% extra on their first.`
    : '';
  return {
    title: 'Invite friends, earn credits',
    body: [yours, theirs].filter(Boolean).join(' '),
    cta: 'Invite friends',
    route: '/invite',
    accent: 'commerce',
    icon: 'gift',
  };
}

/** The tools, for the row's last stop and for a shelf with nothing in it. */
export const HOME_SHELF_START_BLANK_TOOLS = [
  { id: 'image', label: 'Image', route: '/create/image', accent: 'image' },
  { id: 'video', label: 'Video', route: '/create/video', accent: 'video' },
  { id: 'motion', label: 'Motion', route: '/create/motion', accent: 'motion' },
] as const satisfies ReadonlyArray<{ id: string; label: string; route: string; accent: ToolAccent }>;

/** "2 renders in progress", for the line under the shelf's title while something renders. */
export function formatActiveRenders(count: number): string {
  return `${count} render${count === 1 ? '' : 's'} in progress`;
}

/**
 * A card's size: two cards and a sliver of the third across the content
 * column, so the row says it scrolls without a page control. The height is a
 * little over 4:5 and grows with Dynamic Type up to the tier cap the cards'
 * text follows. It is the row's floor: an offer whose terms need more (on a
 * 360dp phone the Invite terms did) makes the whole row taller.
 */
export function getHomeShelfCardSize(contentWidth: number, gap: number, fontScale = 1, maxFontScale = 1.6) {
  const width = Math.round((contentWidth - gap) / 2.3);
  const textScale = Math.min(Math.max(fontScale, 1), maxFontScale);
  return { width, height: Math.round(width * 1.3 + (textScale - 1) * 150) };
}
