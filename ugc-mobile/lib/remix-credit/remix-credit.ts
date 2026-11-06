/**
 * A remix's credit, in one copy the web and the app share by relative import
 * (owner, 2026-11-05: A posts, B remixes A, C remixes B):
 *
 * - every remix post says "Remix of “title” by @A", linking to A's post and to
 *   A, added automatically and never removable by the remixer;
 * - "· Original by @A" follows when the chain began with someone other than the
 *   post remixed's creator ("Remix of “B's title” by @B · Original by @A");
 * - a post remixed that is no longer public and visible loses its link and its
 *   title, and the credit keeps "Original by @A" (assumption 10 of the plan);
 * - nobody with a block between them and the viewer, either way, is named.
 *
 * The server builds the credit from what the post stores
 * (posts.remix_parent_post_id, remix_parent_user_id, remix_origin_user_id,
 * 20261105175340) and leaves out what may not be shown; each client draws the
 * segments it is given. The creator's remix notice ("Remixing @A’s “title”")
 * is here too, so both creators say the same.
 *
 * Metro, Next.js and Vitest all compile this file, so it stays free of React
 * Native, Expo and Node imports (see this folder's tsconfig.json).
 */

/** A creator as a credit names them. */
export type RemixCreditCreator = {
  id: string;
  username: string;
};

/** The post remixed, while it may be linked. */
export type RemixCreditParent = {
  postId: string;
  title: string;
  creator: RemixCreditCreator;
};

/**
 * What a remix post's card and page carry: `parent` while the post remixed is
 * public and visible, `original` when the chain's first creator is someone else
 * or is all there is to name. A post that is no remix carries none.
 */
export type RemixCredit = {
  parent: RemixCreditParent | null;
  original: RemixCreditCreator | null;
};

export const REMIX_CREDIT_WORDS = {
  remixOf: 'Remix of',
  by: 'by',
  originalBy: 'Original by',
  separator: ' · ',
} as const;

/** What the server read for one post: the post remixed and the people the post stores. */
export type RemixCreditSource = {
  /** The post's own creator. */
  postCreatorId: string | null;
  /** The post remixed, as read: `linkable` while it is public, visible and not archived. */
  parentPost: { id: string; title: string; linkable: boolean } | null;
  /** posts.remix_parent_user_id, named by their handle; null without one to name. */
  parentCreator: RemixCreditCreator | null;
  /** posts.remix_origin_user_id, named by their handle; null without one to name. */
  originCreator: RemixCreditCreator | null;
};

/** The credit a post carries, or null when it has nothing it may show. */
export function buildRemixCredit(source: RemixCreditSource): RemixCredit | null {
  const parent: RemixCreditParent | null = source.parentPost?.linkable && source.parentCreator
    ? { postId: source.parentPost.id, title: source.parentPost.title, creator: source.parentCreator }
    : null;
  let original = source.originCreator;
  // Beside the post remixed, the original is named only when it is someone else.
  if (original && parent && original.id === parent.creator.id) original = null;
  // Alone, it never names the post's own creator back to them.
  if (original && !parent && original.id === source.postCreatorId) original = null;
  return parent || original ? { parent, original } : null;
}

/** Everyone a credit names, for asking which of them the viewer is blocked with. */
export function remixCreditUserIds(credit: RemixCredit | null | undefined): string[] {
  if (!credit) return [];
  return [credit.parent?.creator.id, credit.original?.id]
    .filter((id): id is string => Boolean(id));
}

/**
 * The credit without anyone the viewer is blocked with, either way: their post
 * and their name both go. Null when nothing is left to show.
 */
export function withoutBlockedRemixCredit(
  credit: RemixCredit | null | undefined,
  isBlocked: (userId: string) => boolean,
  /** The post's own creator: an original left standing alone never names them back (`buildRemixCredit`). */
  postCreatorId?: string | null,
): RemixCredit | null {
  if (!credit) return null;
  const parent = credit.parent && !isBlocked(credit.parent.creator.id) ? credit.parent : null;
  let original = credit.original && !isBlocked(credit.original.id) ? credit.original : null;
  if (!parent && original && postCreatorId && original.id === postCreatorId) original = null;
  if (parent === credit.parent && original === credit.original) return credit;
  return parent || original ? { parent, original } : null;
}

/** A card that may carry a credit, with its own creator. */
type RemixCreditCard = { remixCredit?: RemixCredit | null; creator?: { id?: string | null } | null };

/**
 * A card with its credit naming no one `isBlocked` picks out; the field goes
 * when no one is left to name. The same card comes back when its credit
 * doesn't change.
 */
export function itemWithoutBlockedRemixCredit<T extends RemixCreditCard>(
  item: T,
  isBlocked: (userId: string) => boolean,
): T {
  if (!item.remixCredit) return item;
  const remixCredit = withoutBlockedRemixCredit(item.remixCredit, isBlocked, item.creator?.id);
  if (remixCredit === item.remixCredit) return item;
  if (remixCredit) return { ...item, remixCredit };
  const uncredited: { remixCredit?: RemixCredit | null } = { ...item };
  delete uncredited.remixCredit;
  return uncredited as T;
}

/**
 * Cards, each as `itemWithoutBlockedRemixCredit` leaves it. The same array
 * comes back when no credit changes, so a list kept in state draws nothing
 * again.
 */
export function itemsWithoutBlockedRemixCredits<T extends RemixCreditCard>(
  items: T[],
  isBlocked: (userId: string) => boolean,
): T[] {
  let changed = false;
  const next = items.map((item) => {
    const kept = itemWithoutBlockedRemixCredit(item, isBlocked);
    if (kept !== item) changed = true;
    return kept;
  });
  return changed ? next : items;
}

export type RemixCreditSegment =
  | { kind: 'text'; text: string }
  /** The post remixed's title, in quotes: opens the post. */
  | { kind: 'post'; text: string; postId: string }
  /** "@handle": opens the creator's page. */
  | { kind: 'creator'; text: string; username: string };

/**
 * The credit as the line reads, in order:
 *   Remix of “Sunset beach” by @cora
 *   Remix of “Sunset, again” by @maya · Original by @cora
 *   Original by @cora
 */
/**
 * The longest title a credit shows in a card's two lines (the web's cards, the
 * app's cards and reel). A line cut at its end would cut "Original by @A" first;
 * a long title shortened leaves it room. What a screen reader hears
 * (`remixCreditLabel`) keeps the whole title.
 */
export const REMIX_CREDIT_CARD_TITLE_MAX_LENGTH = 32;

/** A title at most `maxLength` characters long, cut at a word where one is near, with an ellipsis. */
export function shortenRemixCreditTitle(title: string, maxLength?: number): string {
  const characters = Array.from(title);
  if (!maxLength || characters.length <= maxLength) return title;
  const cut = characters.slice(0, maxLength - 1).join('');
  // A word that ends right at the cut stays; one cut through goes, where a word
  // boundary is near enough to keep most of the title.
  const endsAtWord = characters[maxLength - 1] === ' ';
  const lastSpace = cut.lastIndexOf(' ');
  const atWord = endsAtWord || lastSpace < Math.floor(maxLength * 0.6) ? cut : cut.slice(0, lastSpace);
  return `${atWord.trimEnd()}…`;
}

export function remixCreditSegments(
  credit: RemixCredit,
  options: {
    /** A card's: the title shortened to this many characters (`REMIX_CREDIT_CARD_TITLE_MAX_LENGTH`). */
    titleMaxLength?: number;
  } = {},
): RemixCreditSegment[] {
  const segments: RemixCreditSegment[] = [];
  if (credit.parent) {
    segments.push(
      { kind: 'text', text: `${REMIX_CREDIT_WORDS.remixOf} ` },
      {
        kind: 'post',
        text: `“${shortenRemixCreditTitle(credit.parent.title, options.titleMaxLength)}”`,
        postId: credit.parent.postId,
      },
      { kind: 'text', text: ` ${REMIX_CREDIT_WORDS.by} ` },
      { kind: 'creator', text: `@${credit.parent.creator.username}`, username: credit.parent.creator.username },
    );
  }
  if (credit.original) {
    if (credit.parent) segments.push({ kind: 'text', text: REMIX_CREDIT_WORDS.separator });
    segments.push(
      { kind: 'text', text: `${REMIX_CREDIT_WORDS.originalBy} ` },
      { kind: 'creator', text: `@${credit.original.username}`, username: credit.original.username },
    );
  }
  return segments;
}

/** The whole line as one string: what a screen reader hears, and what a test reads. */
export function remixCreditLabel(credit: RemixCredit): string {
  return remixCreditSegments(credit).map((segment) => segment.text).join('');
}

const HANDLE = /^[a-z0-9_.-]{1,64}$/i;

function readCreator(value: unknown): RemixCreditCreator | null {
  if (!value || typeof value !== 'object') return null;
  const { id, username } = value as { id?: unknown; username?: unknown };
  return typeof id === 'string' && id && typeof username === 'string' && HANDLE.test(username)
    ? { id, username }
    : null;
}

/**
 * A credit as a response carried it, or null for anything else: a card from
 * an older server has none, and a malformed one is drawn as none.
 */
export function readRemixCredit(value: unknown): RemixCredit | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { parent?: unknown; original?: unknown };
  let parent: RemixCreditParent | null = null;
  if (record.parent && typeof record.parent === 'object') {
    const { postId, title, creator } = record.parent as { postId?: unknown; title?: unknown; creator?: unknown };
    const parentCreator = readCreator(creator);
    if (typeof postId === 'string' && postId && typeof title === 'string' && title.trim() && parentCreator) {
      parent = { postId, title: title.trim(), creator: parentCreator };
    }
  }
  const original = readCreator(record.original);
  return parent || original ? { parent, original } : null;
}

/**
 * What a remix's creator says of its source (owner, 2026-11-05): who and what
 * is being remixed, and that they will hear of it. Null for a remix of one's own
 * creation, which tells no one.
 */
export function remixingNotice(source: { username: string | null | undefined; title: string | null | undefined } | null | undefined): {
  label: string;
  line: string;
} | null {
  const username = source?.username?.trim();
  if (!username || !HANDLE.test(username)) return null;
  const title = source?.title?.trim();
  return {
    label: title ? `Remixing @${username}’s “${title}”` : `Remixing @${username}’s post`,
    line: `When your remix is done, @${username} is told you made it.`,
  };
}
