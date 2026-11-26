import type { InfiniteData } from '@tanstack/react-query';

import {
  SUPPORT_FEATURE_IDEA_PREFIX,
  SUPPORT_HUB_TABS,
  SUPPORT_HUB_WORDS,
  appendSupportUpdates,
  applySupportHubReaction,
  groupSupportRoadmapItems,
  hasUnseenSupportUpdates,
  supportHubReactionChips,
  supportHubReactionLabel,
  supportHubReactionPeople,
  supportRoadmapVoteWords,
  supportUpdateCommentWords,
  supportUpdateDateLabel,
  supportUpdatePreview,
  supportUpdatesSeenValue,
  type SupportHubReactionCounts,
  type SupportHubReactionEmoji,
  type SupportHubReactionResponse,
  type SupportHubTab,
  type SupportRoadmapItem,
  type SupportRoadmapResponse,
  type SupportRoadmapStatus,
  type SupportUpdate,
  type SupportUpdateKind,
  type SupportUpdatesPage,
} from './support-hub-policy/support-hub-policy';

/**
 * The app's Help & Support (`app/support.tsx`) apart from React: its three
 * tabs, Chat, Updates and Roadmap (owner, 2026-11-26; plan:
 * docs/plans/help-support-updates-roadmap-plan-2026-11-26.md). The queries it
 * reads, the tabs it has built, the updates as their pages arrive, reactions
 * drawn at once and put back if refused, the roadmap's groups and the unread
 * dot. The rules and words shared with the web and the server are in
 * `support-hub-policy/`; the chat's own are in the support conversation's.
 */

// Queries ---------------------------------------------------------------------

export const SUPPORT_UPDATES_QUERY_KEY = 'support-updates';
export const SUPPORT_ROADMAP_QUERY_KEY = 'support-roadmap';

/** The updates as the reader sees them: `myReaction` is theirs, so the key changes with the account. */
export function supportUpdatesQueryKey(userId: string | null) {
  return [SUPPORT_UPDATES_QUERY_KEY, 'list', userId] as const;
}

/** When the newest update came out: the same for every reader, so one key. */
export const SUPPORT_UPDATES_LATEST_QUERY_KEY = [SUPPORT_UPDATES_QUERY_KEY, 'latest'] as const;

/** The side menu and the tabs ask when the newest update came out at most once a minute. */
export const SUPPORT_UPDATES_LATEST_STALE_MS = 60_000;

export function supportRoadmapQueryKey(userId: string | null) {
  return [SUPPORT_ROADMAP_QUERY_KEY, userId] as const;
}

// Tabs ------------------------------------------------------------------------

export type SupportHubTabOption = {
  value: SupportHubTab;
  label: string;
  /** Spoken in the label's place: "Updates, New updates" while one is unseen. */
  accessibilityLabel?: string;
  /** The unread dot, drawn on Updates while an update is newer than the reader's last look. */
  dot?: boolean;
};

/** The segmented control's choices, in the policy's order and words. */
export function supportHubTabOptions({ unseenUpdates }: { unseenUpdates: boolean }): SupportHubTabOption[] {
  return SUPPORT_HUB_TABS.map((tab) => {
    const label = SUPPORT_HUB_WORDS.tabs[tab];
    if (tab === 'updates' && unseenUpdates) {
      return { value: tab, label, dot: true, accessibilityLabel: `${label}, ${SUPPORT_HUB_WORDS.unreadUpdates}` };
    }
    return { value: tab, label };
  });
}

/**
 * The tabs built so far. A tab is built the first time it is opened and kept
 * after, hidden while another is in front, so the chat keeps its draft, its
 * photo and its place in the thread across a look at Updates. The same list
 * comes back when nothing changes.
 */
export function supportHubMountedTabs(mounted: readonly SupportHubTab[], tab: SupportHubTab): readonly SupportHubTab[] {
  return mounted.includes(tab) ? mounted : [...mounted, tab];
}

/**
 * What "Suggest a feature" puts in the chat's composer: the starting words in
 * an empty one. A draft the person is writing, or a message being edited, is
 * never replaced (null: leave the composer as it is).
 */
export function supportFeatureIdeaDraft({ draft, editing }: { draft: string; editing: boolean }): string | null {
  if (editing || draft.trim().length > 0) return null;
  return SUPPORT_FEATURE_IDEA_PREFIX;
}

// Updates ---------------------------------------------------------------------

/** Every update the pages loaded so far hold, in order, each once. */
export function supportUpdatesFromPages(pages: readonly SupportUpdatesPage[] | undefined): SupportUpdate[] {
  return (pages ?? []).reduce<SupportUpdate[]>((shown, page) => appendSupportUpdates(shown, page.updates), []);
}

/** When the newest update came out, from the first page; undefined until it has loaded. */
export function supportUpdatesLatestAt(pages: readonly SupportUpdatesPage[] | undefined): string | null | undefined {
  const first = pages?.[0];
  return first ? first.latestAt : undefined;
}

/** The cursor of the page after this one, or undefined at the end (React Query's "no next page"). */
export function supportUpdatesNextCursor(page: SupportUpdatesPage): string | undefined {
  return page.nextCursor ?? undefined;
}

export type SupportUpdateCard = {
  id: string;
  kind: SupportUpdateKind;
  kindLabel: string;
  title: string;
  dateLabel: string;
  preview: string;
  commentWords: string;
  commentsLocked: boolean;
  /** The card's button as a screen reader says it: its kind, title, date and first lines. */
  accessibilityLabel: string;
  reactions: SupportHubReactionState;
};

/** An update as its card draws it, its date read against `now` (the time its page was read). */
export function supportUpdateCard(update: SupportUpdate, now: Date): SupportUpdateCard {
  const kindLabel = SUPPORT_HUB_WORDS.kinds[update.kind];
  const dateLabel = supportUpdateDateLabel(update.createdAt, now);
  const preview = supportUpdatePreview(update.body);
  return {
    id: update.id,
    kind: update.kind,
    kindLabel,
    title: update.title,
    dateLabel,
    preview,
    commentWords: supportUpdateCommentWords(update.commentCount, update.commentsLocked),
    commentsLocked: update.commentsLocked,
    accessibilityLabel: [[kindLabel, update.title, dateLabel].filter(Boolean).join(', '), preview]
      .filter(Boolean)
      .join('. '),
    reactions: { reactions: update.reactions, myReaction: update.myReaction },
  };
}

// Reactions -------------------------------------------------------------------

/** One item's reactions as drawn: the counts, and the reader's own. */
export type SupportHubReactionState = {
  reactions: SupportHubReactionCounts;
  myReaction: SupportHubReactionEmoji | null;
};

/** A press on a quick reaction: the reader's own again takes it away, any other becomes theirs. */
export function supportHubReactionTarget(
  current: SupportHubReactionEmoji | null,
  pressed: SupportHubReactionEmoji,
): SupportHubReactionEmoji | null {
  return current === pressed ? null : pressed;
}

/** The state drawn at once when the reader's reaction becomes `next`; the server's answer then replaces it. */
export function supportHubReactionDrawn(
  state: SupportHubReactionState,
  next: SupportHubReactionEmoji | null,
): SupportHubReactionState {
  return { reactions: applySupportHubReaction(state.reactions, state.myReaction, next), myReaction: next };
}

export type SupportHubReactionChip = {
  emoji: SupportHubReactionEmoji;
  count: number;
  mine: boolean;
  /** "👍, 3 people, yours". */
  label: string;
  /** What a press does, for a screen reader. */
  hint: string;
};

/**
 * The chips under an update or a roadmap item: each quick reaction someone
 * chose, in the panel's order, with its count and whether it is the reader's.
 * `canReact` is false for a guest, whose press asks them to sign up.
 */
export function supportHubReactionChipsOf(state: SupportHubReactionState, canReact: boolean): SupportHubReactionChip[] {
  return supportHubReactionChips(state.reactions).map(({ emoji, count }) => {
    const mine = state.myReaction === emoji;
    return {
      emoji,
      count,
      mine,
      label: supportHubReactionLabel(emoji, count, mine),
      hint: !canReact
        ? SUPPORT_HUB_WORDS.signInToReact
        : mine
          ? 'Takes your reaction away'
          : state.myReaction
            ? `Changes your reaction to ${emoji}`
            : `Reacts with ${emoji}`,
    };
  });
}

/** The update's reactions as the screen now draws them, wherever its page is. */
export function withSupportUpdateReaction(
  data: InfiniteData<SupportUpdatesPage> | undefined,
  updateId: string,
  state: SupportHubReactionState,
): InfiniteData<SupportUpdatesPage> | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    if (!page.updates.some((update) => update.id === updateId)) return page;
    changed = true;
    return {
      ...page,
      updates: page.updates.map((update) => (update.id === updateId
        ? { ...update, reactions: state.reactions, myReaction: state.myReaction }
        : update)),
    };
  });
  return changed ? { ...data, pages } : data;
}

/** The roadmap item's reactions as the screen now draws them. */
export function withSupportRoadmapReaction(
  data: SupportRoadmapResponse | undefined,
  itemId: string,
  state: SupportHubReactionState,
): SupportRoadmapResponse | undefined {
  if (!data || !data.items.some((item) => item.id === itemId)) return data;
  return {
    ...data,
    items: data.items.map((item) => (item.id === itemId
      ? { ...item, reactions: state.reactions, myReaction: state.myReaction }
      : item)),
  };
}

export type SupportHubReactor = {
  /** A press on a quick reaction of item `id`, from `current`, what the screen draws for it now. */
  press: (id: string, current: SupportHubReactionState, pressed: SupportHubReactionEmoji) => void;
};

/**
 * Reactions drawn at once and put back if the server refuses them, one item
 * at a time: a press while the last one is still on its way is drawn at once
 * and sent when that answer lands, the latest press kept, as the comments'
 * likes are. Each answer replaces the guess (someone else may have reacted
 * meanwhile); a refusal draws back what the server last held and tells
 * `failed`. The screen supplies the request and where the state is drawn.
 */
export function createSupportHubReactor({
  send,
  draw,
  failed,
}: {
  send: (id: string, emoji: SupportHubReactionEmoji | null) => Promise<SupportHubReactionResponse>;
  draw: (id: string, state: SupportHubReactionState) => void;
  failed: (id: string, error: unknown) => void;
}): SupportHubReactor {
  // What the server last held for an item while a press of it is unsettled.
  const confirmed = new Map<string, SupportHubReactionState>();
  const inFlight = new Set<string>();
  // The latest press made while one was on its way, sent when that one lands.
  const waiting = new Map<string, SupportHubReactionEmoji | null>();

  const run = (id: string, emoji: SupportHubReactionEmoji | null) => {
    inFlight.add(id);
    send(id, emoji).then(
      (answer) => {
        const following = waiting.has(id) ? waiting.get(id) ?? null : undefined;
        waiting.delete(id);
        if (following !== undefined && following !== answer.myReaction) {
          confirmed.set(id, answer);
          draw(id, supportHubReactionDrawn(answer, following));
          run(id, following);
          return;
        }
        inFlight.delete(id);
        confirmed.delete(id);
        draw(id, { reactions: answer.reactions, myReaction: answer.myReaction });
      },
      (error: unknown) => {
        waiting.delete(id);
        inFlight.delete(id);
        const before = confirmed.get(id);
        confirmed.delete(id);
        if (before) draw(id, before);
        failed(id, error);
      },
    );
  };

  return {
    press(id, current, pressed) {
      const next = supportHubReactionTarget(current.myReaction, pressed);
      if (!confirmed.has(id)) confirmed.set(id, current);
      draw(id, supportHubReactionDrawn(current, next));
      if (inFlight.has(id)) {
        waiting.set(id, next);
        return;
      }
      run(id, next);
    },
  };
}

/** The title of the reaction picker: what is being reacted to, on one line. */
export function supportHubReactionSheetTitle(subject: string): string {
  const characters = Array.from(subject.replace(/\s+/g, ' ').trim());
  if (characters.length === 0) return SUPPORT_HUB_WORDS.react;
  return characters.length > 60 ? `${characters.slice(0, 59).join('')}…` : characters.join('');
}

// Roadmap ---------------------------------------------------------------------

export type SupportRoadmapCard = {
  id: string;
  title: string;
  summary: string;
  /** "12 people want this", or "No votes yet". */
  voteWords: string;
  reactions: SupportHubReactionState;
  /** The update that announced a shipped item, opened by "Read the update". */
  readUpdateId: string | null;
};

export type SupportRoadmapSection = {
  status: SupportRoadmapStatus;
  heading: string;
  items: SupportRoadmapCard[];
};

export function supportRoadmapCard(item: SupportRoadmapItem): SupportRoadmapCard {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    voteWords: supportRoadmapVoteWords(supportHubReactionPeople(item.reactions)),
    reactions: { reactions: item.reactions, myReaction: item.myReaction },
    readUpdateId: item.status === 'shipped' ? item.shippedUpdateId : null,
  };
}

/**
 * The roadmap as drawn: Building, Exploring, then Shipped recently, under the
 * policy's headings, read against `now` (the time the roadmap was read), so a
 * shipped item past its thirty days is left out.
 */
export function supportRoadmapSections(items: readonly SupportRoadmapItem[], now: number): SupportRoadmapSection[] {
  return groupSupportRoadmapItems([...items], now).map((group) => ({
    status: group.status,
    heading: SUPPORT_HUB_WORDS.roadmapGroups[group.status],
    items: group.items.map(supportRoadmapCard),
  }));
}

export type SupportRoadmapRow =
  | { kind: 'heading'; key: string; status: SupportRoadmapStatus; heading: string; first: boolean }
  | { kind: 'item'; key: string; card: SupportRoadmapCard };

/** The sections as one list's rows: each heading, then its items. */
export function supportRoadmapRows(sections: readonly SupportRoadmapSection[]): SupportRoadmapRow[] {
  return sections.flatMap((section, index): SupportRoadmapRow[] => [
    { kind: 'heading', key: `heading:${section.status}`, status: section.status, heading: section.heading, first: index === 0 },
    ...section.items.map((card): SupportRoadmapRow => ({ kind: 'item', key: `item:${card.id}`, card })),
  ]);
}

// The unread dot ----------------------------------------------------------------

/** A seen marker as kept on the device: a time, or null for anything else. */
export function readSupportUpdatesSeenAt(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * Whether to draw the unread dot: an update newer than the reader's last look.
 * Nothing until the marker kept on the device has been read, so a reader who
 * looked is never shown a dot that then goes.
 */
export function supportHubUnseenUpdates(
  latestAt: string | null,
  seen: { loaded: boolean; seenAt: string | null },
): boolean {
  return seen.loaded && hasUnseenSupportUpdates(latestAt, seen.seenAt);
}

/** The marker to keep once Updates has shown `latestAt`, or null when the one kept stands. */
export function supportUpdatesSeenToKeep(latestAt: string | null, seenAt: string | null): string | null {
  const next = supportUpdatesSeenValue(readSupportUpdatesSeenAt(latestAt), seenAt);
  return next && next !== seenAt ? next : null;
}
