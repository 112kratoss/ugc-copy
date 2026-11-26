/**
 * Help & Support's three tabs, Chat, Updates and Roadmap (owner, 2026-11-26:
 * "in the help and support when they opens it, i actually want 3 option";
 * plan: docs/plans/help-support-updates-roadmap-plan-2026-11-26.md).
 *
 * Shared by relative import with the server (`src/lib/support-hub-service.ts`
 * and its route adapter), the web's `/support` and the console, and the app's
 * `app/support.tsx`, so every side reads the same answers in the same words.
 * It imports nothing from React Native, Expo or Node: the web bundle and the
 * server compile it too.
 *
 * - Updates are news from the Magicbooklet team: announcements and features
 *   just shipped. Each is a post of the official account, so it opens on the
 *   post page with its comments; people react with the chat's six quick
 *   reactions, one each.
 * - The roadmap is what is being built. People react to an item, and the
 *   number of people is its vote; "Suggest a feature" opens the chat.
 */

import {
  SUPPORT_CONVERSATION_PATH,
  SUPPORT_REACTION_EMOJIS,
  isSupportReactionEmoji,
  type SupportReactionEmoji,
} from '../support-conversation-policy/support-conversation-policy';

export { SUPPORT_REACTION_EMOJIS as SUPPORT_HUB_REACTION_EMOJIS };
export type SupportHubReactionEmoji = SupportReactionEmoji;

// Tabs ----------------------------------------------------------------------

export type SupportHubTab = 'chat' | 'updates' | 'roadmap';

/** The tabs in the order they are drawn. Help & Support opens on the chat. */
export const SUPPORT_HUB_TABS: readonly SupportHubTab[] = ['chat', 'updates', 'roadmap'];
export const SUPPORT_HUB_DEFAULT_TAB: SupportHubTab = 'chat';

/** The address parameter, and the app route's, that names the tab. */
export const SUPPORT_HUB_TAB_PARAM = 'tab';

export function isSupportHubTab(value: unknown): value is SupportHubTab {
  return value === 'chat' || value === 'updates' || value === 'roadmap';
}

/** The tab an address or route parameter names; anything else is the chat. */
export function readSupportHubTab(value: unknown): SupportHubTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return isSupportHubTab(raw) ? raw : SUPPORT_HUB_DEFAULT_TAB;
}

/** `/support`, `/support?tab=updates` or `/support?tab=roadmap`. */
export function supportHubPath(tab: SupportHubTab): string {
  return tab === SUPPORT_HUB_DEFAULT_TAB
    ? SUPPORT_CONVERSATION_PATH
    : `${SUPPORT_CONVERSATION_PATH}?${SUPPORT_HUB_TAB_PARAM}=${tab}`;
}

// Reactions -----------------------------------------------------------------

/** How many people reacted with each quick reaction. */
export type SupportHubReactionCounts = Partial<Record<SupportReactionEmoji, number>>;

export type SupportHubReactionRequest = { emoji: SupportReactionEmoji | null };

export type SupportHubReactionResponse = {
  reactions: SupportHubReactionCounts;
  myReaction: SupportReactionEmoji | null;
};

/** The request body of a reaction, or null when it is not one. */
export function readSupportHubReactionRequest(value: unknown): SupportHubReactionRequest | null {
  if (!value || typeof value !== 'object' || !('emoji' in value)) return null;
  const emoji = (value as { emoji: unknown }).emoji;
  if (emoji === null) return { emoji: null };
  return isSupportReactionEmoji(emoji) ? { emoji } : null;
}

/** Counts as the server sends them, keeping only quick reactions with a whole, positive count. */
export function readSupportHubReactionCounts(value: unknown): SupportHubReactionCounts {
  const counts: SupportHubReactionCounts = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return counts;
  for (const [emoji, count] of Object.entries(value as Record<string, unknown>)) {
    if (isSupportReactionEmoji(emoji) && typeof count === 'number' && Number.isInteger(count) && count > 0) {
      counts[emoji] = count;
    }
  }
  return counts;
}

export function readSupportHubReactionResponse(value: unknown): SupportHubReactionResponse | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const myReaction = record.myReaction === null || record.myReaction === undefined
    ? null
    : isSupportReactionEmoji(record.myReaction) ? record.myReaction : undefined;
  if (myReaction === undefined) return null;
  return { reactions: readSupportHubReactionCounts(record.reactions), myReaction };
}

/** The number of people who reacted, whatever with. */
export function supportHubReactionPeople(counts: SupportHubReactionCounts): number {
  return Object.values(counts).reduce((total, count) => total + (count ?? 0), 0);
}

/**
 * The counts once the reader's reaction changes from `from` to `to`, drawn at
 * once while the request is on its way; the answer then replaces them.
 */
export function applySupportHubReaction(
  counts: SupportHubReactionCounts,
  from: SupportReactionEmoji | null,
  to: SupportReactionEmoji | null,
): SupportHubReactionCounts {
  const next: SupportHubReactionCounts = { ...counts };
  if (from) {
    const left = (next[from] ?? 0) - 1;
    if (left > 0) next[from] = left;
    else delete next[from];
  }
  if (to) next[to] = (next[to] ?? 0) + 1;
  return next;
}

/** The quick reactions with at least one person, in the panel's order. */
export function supportHubReactionChips(counts: SupportHubReactionCounts): Array<{ emoji: SupportReactionEmoji; count: number }> {
  return SUPPORT_REACTION_EMOJIS
    .map((emoji) => ({ emoji, count: counts[emoji] ?? 0 }))
    .filter((chip) => chip.count > 0);
}

// Updates -------------------------------------------------------------------

export type SupportUpdateKind = 'announcement' | 'shipped';
export const SUPPORT_UPDATE_KINDS: readonly SupportUpdateKind[] = ['announcement', 'shipped'];

export function isSupportUpdateKind(value: unknown): value is SupportUpdateKind {
  return value === 'announcement' || value === 'shipped';
}

/** A page of updates holds at most this many; the dot asks for one. */
export const SUPPORT_UPDATES_PAGE_SIZE = 20;

/**
 * The console's limits for an update's words: a post's own (`TITLE_MAX_LENGTH`
 * in `src/lib/post-limits.ts`, `BODY_MAX_LENGTH` in `src/lib/posts-server.ts`),
 * since an update is a post; `support-hub-policy.test.ts` holds them equal.
 */
export const SUPPORT_UPDATE_TITLE_MAX_LENGTH = 100;
export const SUPPORT_UPDATE_BODY_MAX_LENGTH = 2000;

export type SupportUpdate = {
  /** The post's id: the update opens on the post page, `/showcase/<id>`. */
  id: string;
  kind: SupportUpdateKind;
  title: string;
  body: string;
  createdAt: string;
  commentCount: number;
  commentsLocked: boolean;
  reactions: SupportHubReactionCounts;
  myReaction: SupportReactionEmoji | null;
};

export type SupportUpdatesPage = {
  updates: SupportUpdate[];
  nextCursor: string | null;
  /** When the newest update was published (first page only), for the unread dot. */
  latestAt: string | null;
};

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

export function readSupportUpdate(value: unknown): SupportUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  const createdAt = readString(record.createdAt);
  if (!id || !createdAt || !isSupportUpdateKind(record.kind)) return null;
  const myReaction = isSupportReactionEmoji(record.myReaction) ? record.myReaction : null;
  return {
    id,
    kind: record.kind,
    title: readString(record.title) ?? '',
    body: readString(record.body) ?? '',
    createdAt,
    commentCount: readCount(record.commentCount),
    commentsLocked: record.commentsLocked === true,
    reactions: readSupportHubReactionCounts(record.reactions),
    myReaction,
  };
}

export function readSupportUpdatesPage(value: unknown): SupportUpdatesPage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.updates)) return null;
  return {
    updates: record.updates.map(readSupportUpdate).filter((update): update is SupportUpdate => update !== null),
    nextCursor: readString(record.nextCursor),
    latestAt: readString(record.latestAt),
  };
}

/** A page appended to the updates already drawn, leaving out any already there. */
export function appendSupportUpdates(shown: SupportUpdate[], page: SupportUpdate[]): SupportUpdate[] {
  const ids = new Set(shown.map((update) => update.id));
  return [...shown, ...page.filter((update) => !ids.has(update.id))];
}

/** The first lines of an update, cut at a word, for its card. */
export function supportUpdatePreview(body: string, maxLength = 220): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// The unread dot --------------------------------------------------------------

/** Where each device keeps when the reader last looked at Updates (AsyncStorage, localStorage). */
export const SUPPORT_UPDATES_SEEN_STORAGE_KEY = 'magicbooklet.support-updates.seen-at';

/**
 * Whether there is an update the reader has not seen: one published after
 * their last look. A reader who never looked has news once anything is
 * published.
 */
export function hasUnseenSupportUpdates(latestAt: string | null, seenAt: string | null): boolean {
  if (!latestAt) return false;
  const latest = Date.parse(latestAt);
  if (!Number.isFinite(latest)) return false;
  if (!seenAt) return true;
  const seen = Date.parse(seenAt);
  return !Number.isFinite(seen) || latest > seen;
}

/** The value kept once Updates has been looked at: the newest it showed, never earlier than one kept. */
export function supportUpdatesSeenValue(latestAt: string | null, seenAt: string | null): string | null {
  if (!latestAt) return seenAt;
  if (!seenAt) return latestAt;
  return Date.parse(latestAt) > Date.parse(seenAt) ? latestAt : seenAt;
}

// Roadmap -------------------------------------------------------------------

export type SupportRoadmapStatus = 'exploring' | 'building' | 'shipped';
export const SUPPORT_ROADMAP_STATUSES: readonly SupportRoadmapStatus[] = ['exploring', 'building', 'shipped'];

/** The groups in the order they are drawn: what is being built first. */
export const SUPPORT_ROADMAP_GROUP_ORDER: readonly SupportRoadmapStatus[] = ['building', 'exploring', 'shipped'];

/** A shipped item stays under "Shipped recently" this long, then lives on as its update. */
export const SUPPORT_ROADMAP_SHIPPED_DAYS = 30;

export const SUPPORT_ROADMAP_TITLE_MAX_LENGTH = 80;
export const SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH = 280;

export function isSupportRoadmapStatus(value: unknown): value is SupportRoadmapStatus {
  return value === 'exploring' || value === 'building' || value === 'shipped';
}

export type SupportRoadmapItem = {
  id: string;
  title: string;
  summary: string;
  status: SupportRoadmapStatus;
  shippedAt: string | null;
  /** The update that announced it, once shipped. */
  shippedUpdateId: string | null;
  reactions: SupportHubReactionCounts;
  myReaction: SupportReactionEmoji | null;
};

export type SupportRoadmapResponse = { items: SupportRoadmapItem[] };

export function readSupportRoadmapItem(value: unknown): SupportRoadmapItem | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  if (!id || !isSupportRoadmapStatus(record.status)) return null;
  return {
    id,
    title: readString(record.title) ?? '',
    summary: readString(record.summary) ?? '',
    status: record.status,
    shippedAt: readString(record.shippedAt),
    shippedUpdateId: readString(record.shippedUpdateId),
    reactions: readSupportHubReactionCounts(record.reactions),
    myReaction: isSupportReactionEmoji(record.myReaction) ? record.myReaction : null,
  };
}

export function readSupportRoadmapResponse(value: unknown): SupportRoadmapResponse | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items)) return null;
  return {
    items: record.items.map(readSupportRoadmapItem).filter((item): item is SupportRoadmapItem => item !== null),
  };
}

/** Whether a shipped item still belongs under "Shipped recently". */
export function isRecentlyShippedSupportRoadmapItem(item: Pick<SupportRoadmapItem, 'status' | 'shippedAt'>, now: number): boolean {
  if (item.status !== 'shipped' || !item.shippedAt) return false;
  const shipped = Date.parse(item.shippedAt);
  return Number.isFinite(shipped) && now - shipped <= SUPPORT_ROADMAP_SHIPPED_DAYS * 24 * 60 * 60 * 1000;
}

export type SupportRoadmapGroup = { status: SupportRoadmapStatus; items: SupportRoadmapItem[] };

/**
 * The roadmap as drawn: Building, Exploring, then Shipped recently, each in
 * the console's order; empty groups left out, and shipped items past their
 * thirty days too.
 */
export function groupSupportRoadmapItems(items: SupportRoadmapItem[], now: number): SupportRoadmapGroup[] {
  return SUPPORT_ROADMAP_GROUP_ORDER
    .map((status) => ({
      status,
      items: items.filter((item) => item.status === status
        && (status !== 'shipped' || isRecentlyShippedSupportRoadmapItem(item, now))),
    }))
    .filter((group) => group.items.length > 0);
}

/** What "Suggest a feature" puts in the chat's composer. */
export const SUPPORT_FEATURE_IDEA_PREFIX = 'Feature idea: ';

// Alerts --------------------------------------------------------------------

/** The alert that announces an update to every account: its kind's line, then the update's title. */
export function supportUpdateAlertWords(kind: SupportUpdateKind, title: string): { title: string; body: string } {
  return {
    title: kind === 'shipped' ? 'New on Magicbooklet' : 'News from Magicbooklet',
    body: title.trim().slice(0, 300) || 'Open it to read more.',
  };
}

/** The alert to everyone who reacted to a roadmap item once it ships. */
export function supportRoadmapShippedAlertWords(itemTitle: string): { title: string; body: string } {
  const title = itemTitle.trim();
  return {
    title: 'You asked, it’s live',
    body: title ? `${title.slice(0, 200)} is here. Take a look.` : 'Something you wanted is here. Take a look.',
  };
}

// Words ---------------------------------------------------------------------

/** The refusal code of a comment on a locked post, and its words. */
export const SUPPORT_COMMENTS_LOCKED_CODE = 'COMMENTS_LOCKED';

export const SUPPORT_HUB_WORDS = {
  title: 'Help & Support',
  tabs: { chat: 'Chat', updates: 'Updates', roadmap: 'Roadmap' } satisfies Record<SupportHubTab, string>,
  tabsLabel: 'Help & Support sections',
  unreadUpdates: 'New updates',
  kinds: { announcement: 'Announcement', shipped: 'New' } satisfies Record<SupportUpdateKind, string>,
  updatesEmptyTitle: 'No updates yet',
  updatesEmptyBody: 'News from the Magicbooklet team will show up here.',
  updatesLoadFailed: 'Updates could not be loaded. Check your connection, then try again.',
  loadMore: 'Show more',
  commentsOff: 'Comments are off',
  commentsLockedRefusal: 'Comments are off for this post.',
  openComments: 'Open comments',
  roadmapIntro: 'What we’re working on. React to the ones you want most.',
  roadmapEmptyTitle: 'Nothing on the roadmap yet',
  roadmapEmptyBody: 'Have an idea? Tell us in the chat.',
  roadmapLoadFailed: 'The roadmap could not be loaded. Check your connection, then try again.',
  roadmapGroups: { building: 'Building', exploring: 'Exploring', shipped: 'Shipped recently' } satisfies Record<SupportRoadmapStatus, string>,
  readUpdate: 'Read the update',
  suggestFeature: 'Suggest a feature',
  suggestFeatureLine: 'Missing something? Tell us in the chat.',
  signInToReact: 'Sign in to react',
  react: 'React',
  reactionFailed: 'Your reaction was not saved. Try again.',
  tryAgain: 'Try again',
} as const;

/** "12 comments", "1 comment", or the words for none. */
export function supportUpdateCommentWords(count: number, locked: boolean): string {
  if (locked && count === 0) return SUPPORT_HUB_WORDS.commentsOff;
  if (count === 0) return 'Comment';
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'comment' : 'comments'}`;
}

/** The spoken label of a reaction chip: "👍, 3 people, yours". */
export function supportHubReactionLabel(emoji: SupportReactionEmoji, count: number, mine: boolean): string {
  const people = `${count.toLocaleString('en-US')} ${count === 1 ? 'person' : 'people'}`;
  return mine ? `${emoji}, ${people}, yours` : `${emoji}, ${people}`;
}

/** The spoken vote count of a roadmap item. */
export function supportRoadmapVoteWords(people: number): string {
  if (people === 0) return 'No votes yet';
  return `${people.toLocaleString('en-US')} ${people === 1 ? 'person wants' : 'people want'} this`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * An update's date as its card says it: "Today", "Yesterday", "26 Nov", and
 * "26 Nov 2025" in another year. Formatted by hand, in the reader's time zone,
 * so the server's HTML, a browser and Hermes say the same.
 */
export function supportUpdateDateLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / (24 * 60 * 60 * 1000));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const label = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${date.getFullYear()}`;
}
