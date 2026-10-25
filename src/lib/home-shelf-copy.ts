import type { HomeShelfAction, HomeShelfCreation, HomeShelfCreator, HomeShelfPrice } from '@/lib/home-shelf';

/**
 * What the "Make this" shelf says on the web, kept apart from `home-shelf.ts`
 * so the client component imports words and no server-side rules. The app says
 * the same words from `ugc-mobile/lib/home-shelf-view-model.ts`; both are held
 * to `contracts/mobile-api-v1.json` (`getHomeShelf.copy`).
 */

// Two decimals, as /invite and every other referral surface prints the terms:
// they are basis points over 100, and 725 bps is 7.25%, never "7.3%".
const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

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

/** "@handle", or the display name for a creator without one. */
export function homeShelfCreatorLabel(creator: HomeShelfCreator): string | null {
  return creator.username ? `@${creator.username}` : creator.name;
}

export interface HomeShelfActionCopy {
  title: string;
  body: string;
  cta: string;
  href: string;
}

export function homeShelfActionCopy(action: HomeShelfAction): HomeShelfActionCopy {
  if (action.id === 'post') {
    return {
      title: 'Share your first post',
      body: 'Post a creation or a tip to the feed.',
      cta: 'Post now',
      href: '/post/new',
    };
  }

  if (action.id === 'earn') {
    return {
      title: 'Earn from your prompts',
      body: `Add a recipe to a post, set a price, and keep ${percent.format(action.creatorSharePercent)}% of each sale.`,
      cta: 'Start selling',
      href: '/marketplace/sell',
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
    href: '/invite',
  };
}
