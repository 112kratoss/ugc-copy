import { formatCreditCost } from './generation-action-label';
import type { ToolAccent } from './theme';
import type { HomeShelfAction, HomeShelfCreation, HomeShelfItem, HomeShelfPrice, HomeShelfResponse } from './types';

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
 * The items this build knows how to draw, in the server's order. A newer
 * server may add a kind of card; an older app skips it rather than drawing it
 * wrong, and a creation without a post to remix is skipped too.
 */
export function readHomeShelfItems(response: HomeShelfResponse | null | undefined): HomeShelfItem[] {
  if (!response || !Array.isArray(response.items)) return [];

  return response.items.filter((item): item is HomeShelfItem => {
    if (!item || typeof item !== 'object') return false;
    if (item.kind === 'action') return ACTION_IDS.has(item.id);
    if (item.kind === 'creation') {
      return CREATION_TOOLS.has(item.tool) && Boolean(item.posterUrl) && Boolean(item.post?.id);
    }
    return false;
  });
}

/**
 * The answer to keep on screen while another identity's loads: the creations,
 * which are the same for everyone, and none of the last person's offers.
 */
export function keepHomeShelfCreations(response: HomeShelfResponse | undefined): HomeShelfResponse | undefined {
  if (!response) return undefined;
  return { ...response, items: response.items.filter((item) => item.kind === 'creation') };
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

/** What a screen reader says for a creation card, in reading order. */
export function homeShelfCreationLabel(creation: HomeShelfCreation): string {
  const handle = homeShelfCreatorLabel(creation.creator);
  return [
    creation.title,
    creation.modelName,
    formatHomeShelfPrice(creation.price),
    handle ? `by ${handle}` : null,
  ].filter(Boolean).join(', ');
}

/**
 * The poster's cache identity: the feed's own key for the same media, so a
 * pinned post that is also in the feed is fetched and stored once.
 */
export function homeShelfPosterCacheKey(creation: HomeShelfCreation): string {
  const lead = (creation.post.mediaItems ?? []).slice().sort((left, right) => left.sortOrder - right.sortOrder)[0];
  return lead?.previewCacheKey ?? creation.posterUrl;
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
 * little over 4:5 so an offer's terms fit at the default text size, and grows
 * with Dynamic Type up to the tier cap the cards' text follows, so larger text
 * makes taller cards instead of clipped ones.
 */
export function getHomeShelfCardSize(contentWidth: number, gap: number, fontScale = 1, maxFontScale = 1.6) {
  const width = Math.round((contentWidth - gap) / 2.3);
  const textScale = Math.min(Math.max(fontScale, 1), maxFontScale);
  return { width, height: Math.round(width * 1.3 + (textScale - 1) * 150) };
}
