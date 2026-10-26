import { getPublicPostQualityError } from '@/lib/marketplace-trust';
import { remixToolCreatePath, type RemixTool } from '@/lib/remix-tools';
import { getShowcaseItemMediaItems, type ShowcaseFeedItem } from '@/lib/showcase';

/**
 * The "Make this" shelf that opens Home on the web and in the app: real
 * creations a viewer can make their own in one tap, with at most two action
 * cards (post, invite, earn) for signed-in members.
 *
 * Pure module: no server reads, no React. `home-shelf-server.ts` gathers the
 * posts, prices and viewer facts and hands them here; the API route sends the
 * result to the app (`/api/home/shelf`, `contracts/mobile-api-v1.json`), and
 * the web pages render it directly. What the cards say is in
 * `home-shelf-copy.ts`, which the client component can import alone.
 */

/** The response shape version `/api/home/shelf` sends. */
export const HOME_SHELF_SCHEMA_VERSION = 1;

/**
 * Below this many creations the shelf renders nothing: two cards and an offer
 * read as a broken row, not a shelf.
 */
export const HOME_SHELF_MIN_CREATIONS = 3;

/** Creations never outnumber this, so the offers stay a minority of the row. */
export const HOME_SHELF_MAX_CREATIONS = 6;

/** Post or Earn sits after the second creation; an action card is never first. */
const HOME_SHELF_LEAD_ACTION_INDEX = 2;

export type HomeShelfBadge = 'new-model';

export interface HomeShelfPin {
  postId: string;
  /**
   * Set by hand for a launch. The catalog's own "New" badge stays on models
   * for months (`selectWhatsNewModels` in home-dashboard.ts says how many), so
   * deriving it from there would mark most of the shelf as new.
   */
  badge?: HomeShelfBadge;
}

export type HomeShelfPrice =
  | { kind: 'credits'; credits: number }
  /** Motion is priced by the length of the clip the viewer brings (owner, 2026-10-20). */
  | { kind: 'clip-length' };

export interface HomeShelfCreator {
  /** Lets the web's card leave with the creator's posts when the viewer blocks or hides them. */
  id: string | null;
  username: string | null;
  name: string | null;
}

export interface HomeShelfCreation {
  kind: 'creation';
  /** The post's id. */
  id: string;
  title: string;
  tool: RemixTool;
  posterUrl: string;
  posterThumbhash: string | null;
  /** The feed's server-chosen stream for a video post; null shows the poster only. */
  clipUrl: string | null;
  modelName: string | null;
  price: HomeShelfPrice | null;
  /**
   * The price fits the welcome credits a new account is given, so a viewer
   * without an account can make this for free once they sign up.
   */
  fitsWelcomeCredits: boolean;
  badge: HomeShelfBadge | null;
  creator: HomeShelfCreator;
  /**
   * The creator page that opens this remix. The create pages carry `remix` and
   * `remixPost` through sign-in, so a signed-out tap lands in the same editor.
   */
  makeHref: string;
}

export type HomeShelfAction =
  | { kind: 'action'; id: 'post' }
  | { kind: 'action'; id: 'invite'; inviterPercent: number; inviteePercent: number }
  | { kind: 'action'; id: 'earn'; creatorSharePercent: number };

export type HomeShelfItem = HomeShelfCreation | HomeShelfAction;

export interface HomeShelfCreationFacts {
  modelName: string | null;
  price: HomeShelfPrice | null;
  /** The welcome grant while its program is enabled; null leaves "Free to try" off. */
  welcomeCredits: number | null;
}

export interface HomeShelfActionFacts {
  /** The active referral program's terms; null while none is active or readable. */
  referral: { inviterPercent: number; inviteePercent: number } | null;
  /** The switch in `home-shelf-lineup.ts`: off until a test sale and payout have worked. */
  earnEnabled: boolean;
  creatorSharePercent: number;
}

const SHELF_TOOLS: ReadonlySet<string> = new Set<RemixTool>(['image', 'video', 'motion']);

export function buildHomeShelfMakeHref(tool: RemixTool, generationId: string, postId: string): string {
  const params = new URLSearchParams({ remix: generationId, remixPost: postId });

  return `${remixToolCreatePath(tool)}?${params.toString()}`;
}

/**
 * One pinned post as a shelf card, or null when it should not be on the shelf.
 *
 * A pin is checked again on every build rather than trusted: a post can be
 * archived, hidden by moderation, or have its remix put behind a recipe after
 * it was pinned, and a card that cannot be made is worse than no card. The
 * read it comes from (`getShowcaseFeedItemsByPostIds`) already drops posts that
 * are not public, archived or hidden by moderation. The tool is the one the
 * remix endpoint opens (`remixTarget`, motion included through creation mode).
 */
export function toHomeShelfCreation(
  item: ShowcaseFeedItem,
  pin: HomeShelfPin,
  facts: HomeShelfCreationFacts,
): HomeShelfCreation | null {
  if (item.id !== pin.postId || item.isNsfw || !item.generationId) return null;
  // Only a remix that is open to everyone: a recipe sold with its remix needs
  // the unlock sheet, which a one-tap card cannot offer.
  if (item.remixCapability !== 'public') return null;
  const tool = item.remixTarget;
  if (!tool || !SHELF_TOOLS.has(tool)) return null;

  const media = getShowcaseItemMediaItems(item)[0];
  if (!media?.previewUrl || media.sourceUnavailableAt) return null;

  const title = item.title?.trim() ?? '';
  if (!title || getPublicPostQualityError({ title, hasMedia: true })) return null;

  const shelfTool = tool as RemixTool;
  const price = facts.price;

  return {
    kind: 'creation',
    id: item.id,
    title,
    tool: shelfTool,
    posterUrl: media.previewUrl,
    posterThumbhash: media.previewThumbhash ?? null,
    clipUrl: media.mediaKind === 'video' ? media.feedStreamUrl ?? null : null,
    modelName: facts.modelName,
    price,
    fitsWelcomeCredits: price?.kind === 'credits'
      && facts.welcomeCredits !== null
      && price.credits <= facts.welcomeCredits,
    badge: pin.badge ?? null,
    creator: {
      id: item.creator?.id ?? null,
      username: item.creator?.username ?? null,
      name: item.creator?.name ?? null,
    },
    makeHref: buildHomeShelfMakeHref(shelfTool, item.generationId, item.id),
  };
}

/**
 * The action cards a member is offered: at most two, and only ones that fit
 * where they are. Someone who has never posted is asked to post; someone who
 * has is asked to sell, once selling is switched on. Invite goes to every
 * member while a referral program is running. Signed-out visitors and guests
 * are offered none, and the server never asks for them (`home-shelf-server.ts`):
 * a guest cannot post publicly, invite anyone or sell.
 */
export function selectHomeShelfActions(
  member: { hasPosted: boolean },
  facts: HomeShelfActionFacts,
): HomeShelfAction[] {
  const actions: HomeShelfAction[] = [];
  if (!member.hasPosted) {
    actions.push({ kind: 'action', id: 'post' });
  } else if (facts.earnEnabled) {
    actions.push({ kind: 'action', id: 'earn', creatorSharePercent: facts.creatorSharePercent });
  }

  const referral = facts.referral;
  if (referral && (referral.inviterPercent > 0 || referral.inviteePercent > 0)) {
    actions.push({
      kind: 'action',
      id: 'invite',
      inviterPercent: referral.inviterPercent,
      inviteePercent: referral.inviteePercent,
    });
  }

  return actions;
}

/**
 * The shelf in display order. Post or Earn takes the third place and Invite the
 * last, wherever they arrive in `actions`, so switching Earn off leaves Invite
 * at the end instead of promoting it into the row. Generic so the API can
 * arrange creations that carry their post and get them back the same way.
 */
export function arrangeHomeShelf<C extends HomeShelfCreation>(
  creations: C[],
  actions: HomeShelfAction[],
): Array<C | HomeShelfAction> {
  const shown = creations.slice(0, HOME_SHELF_MAX_CREATIONS);
  if (shown.length < HOME_SHELF_MIN_CREATIONS) return [];

  const lead = actions.find((action) => action.id === 'post' || action.id === 'earn');
  const trailing = actions.find((action) => action.id === 'invite');
  const items: Array<C | HomeShelfAction> = [...shown];
  if (lead) items.splice(HOME_SHELF_LEAD_ACTION_INDEX, 0, lead);
  if (trailing) items.push(trailing);

  return items;
}
