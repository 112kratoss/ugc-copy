import type { ToolAccent } from './theme';
import type { HomeShelfAction, HomeShelfCreation, HomeShelfItem, HomeShelfPrice, HomeShelfResponse } from './types';

/**
 * Home's "Make this" shelf, as the app draws it: what the server sent
 * (`GET /api/home/shelf`), in words. The web draws the same shelf from
 * `src/components/HomeShelf.tsx`; the words both say are pinned to one answer
 * by `contracts/mobile-api-v1.json` (`getHomeShelf.copy`).
 */

const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

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

/** "15 credits", "Priced by clip length", or nothing when the price is unknown. */
export function formatHomeShelfPrice(price: HomeShelfPrice | null): string | null {
  if (!price) return null;
  if (price.kind === 'clip-length') return 'Priced by clip length';
  return `${price.credits} ${price.credits === 1 ? 'credit' : 'credits'}`;
}

/**
 * One badge at most: a launch outranks the welcome credits, and "Free to try"
 * is said only to someone still owed them (signed out, or a guest).
 */
export function homeShelfBadge(creation: HomeShelfCreation, offerFreeToTry: boolean): string | null {
  if (creation.badge === 'new-model') return 'New model';
  return offerFreeToTry && creation.fitsWelcomeCredits ? 'Free to try' : null;
}

/** What a screen reader says for a creation card, in reading order. */
export function homeShelfCreationLabel(creation: HomeShelfCreation): string {
  const handle = creation.creator.username ? `@${creation.creator.username}` : creation.creator.name;
  return [
    creation.title,
    creation.modelName,
    formatHomeShelfPrice(creation.price),
    handle ? `by ${handle}` : null,
  ].filter(Boolean).join(', ');
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

/** The row's last stop: the tools, for someone who would rather start from nothing. */
export const HOME_SHELF_START_BLANK_TOOLS = [
  { id: 'image', label: 'Image', route: '/create/image' },
  { id: 'video', label: 'Video', route: '/create/video' },
  { id: 'motion', label: 'Motion', route: '/create/motion' },
] as const;

/**
 * Card width for a phone: two cards and a sliver of the third across the
 * content column, so the row says it scrolls without a page control.
 */
export function getHomeShelfCardWidth(contentWidth: number, gap: number): number {
  return Math.round((contentWidth - gap) / 2.3);
}
