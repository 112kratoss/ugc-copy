import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  readSupportRoadmapResponse,
  readSupportUpdatesPage,
  type SupportHubReactionResponse,
  type SupportRoadmapItem,
  type SupportUpdate,
  type SupportUpdatesPage,
} from '../lib/support-hub-policy/support-hub-policy';
import {
  SUPPORT_UPDATES_LATEST_QUERY_KEY,
  SUPPORT_UPDATES_LATEST_STALE_MS,
  createSupportHubReactor,
  readSupportUpdatesSeenAt,
  supportFeatureIdeaDraft,
  supportHubMountedTabs,
  supportHubReactionChipsOf,
  supportHubReactionDrawn,
  supportHubReactionSheetTitle,
  supportHubReactionTarget,
  supportHubTabOptions,
  supportHubUnseenUpdates,
  supportRoadmapQueryKey,
  supportRoadmapRows,
  supportRoadmapSections,
  supportUpdateCard,
  supportUpdatesFromPages,
  supportUpdatesLatestAt,
  supportUpdatesNextCursor,
  supportUpdatesQueryKey,
  supportUpdatesSeenToKeep,
  withSupportRoadmapReaction,
  withSupportUpdateReaction,
  type SupportHubReactionState,
} from '../lib/support-hub-view-model';

const endpoints = mobileApiContract.endpoints;
const contractPage = readSupportUpdatesPage(endpoints.getSupportUpdates.response)!;
const contractRoadmap = readSupportRoadmapResponse(endpoints.getSupportRoadmap.response)!;

function update(overrides: Partial<SupportUpdate> = {}): SupportUpdate {
  return {
    id: 'update-1',
    kind: 'announcement',
    title: 'Folders are here',
    body: 'Group your creations into folders.',
    createdAt: '2026-11-26T12:00:00.000Z',
    commentCount: 0,
    commentsLocked: false,
    reactions: {},
    myReaction: null,
    ...overrides,
  };
}

function page(updates: SupportUpdate[], overrides: Partial<SupportUpdatesPage> = {}): SupportUpdatesPage {
  return { updates, nextCursor: null, latestAt: updates[0]?.createdAt ?? null, ...overrides };
}

function item(overrides: Partial<SupportRoadmapItem> = {}): SupportRoadmapItem {
  return {
    id: 'item-1',
    title: 'Folders',
    summary: '',
    status: 'building',
    shippedAt: null,
    shippedUpdateId: null,
    reactions: {},
    myReaction: null,
    ...overrides,
  };
}

/** A promise held open by the test, settled when it says. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('the queries Help & Support reads', () => {
  it('keys the updates and the roadmap by the reader, whose reactions they carry, and the newest update by nothing', () => {
    expect(supportUpdatesQueryKey('account-1')).toEqual(['support-updates', 'list', 'account-1']);
    expect(supportUpdatesQueryKey(null)).toEqual(['support-updates', 'list', null]);
    expect(supportRoadmapQueryKey('account-1')).toEqual(['support-roadmap', 'account-1']);
    expect(SUPPORT_UPDATES_LATEST_QUERY_KEY).toEqual(['support-updates', 'latest']);
    // The menu asks at most once a minute.
    expect(SUPPORT_UPDATES_LATEST_STALE_MS).toBe(60_000);
  });
});

describe('the tabs', () => {
  it('offers Chat, Updates and Roadmap in the policy\'s order and words', () => {
    expect(supportHubTabOptions({ unseenUpdates: false })).toEqual([
      { value: 'chat', label: 'Chat' },
      { value: 'updates', label: 'Updates' },
      { value: 'roadmap', label: 'Roadmap' },
    ]);
  });

  it('puts the dot on Updates while one is unseen, and says so to a screen reader', () => {
    expect(supportHubTabOptions({ unseenUpdates: true })[1]).toEqual({
      value: 'updates',
      label: 'Updates',
      dot: true,
      accessibilityLabel: 'Updates, New updates',
    });
  });

  it('builds a tab once, the first time it is opened, and keeps it', () => {
    const first = supportHubMountedTabs([], 'chat');
    expect(first).toEqual(['chat']);
    const both = supportHubMountedTabs(first, 'roadmap');
    expect(both).toEqual(['chat', 'roadmap']);
    // The same list when nothing changes, so the screen does not draw again for it.
    expect(supportHubMountedTabs(both, 'chat')).toBe(both);
  });

  it('starts an empty composer with "Feature idea: ", and never replaces a draft or an edit', () => {
    expect(supportFeatureIdeaDraft({ draft: '', editing: false })).toBe('Feature idea: ');
    expect(supportFeatureIdeaDraft({ draft: '   ', editing: false })).toBe('Feature idea: ');
    expect(supportFeatureIdeaDraft({ draft: 'My video failed', editing: false })).toBeNull();
    expect(supportFeatureIdeaDraft({ draft: '', editing: true })).toBeNull();
  });
});

describe('the updates', () => {
  it('flattens the pages in order, each update once, a later page repeating an earlier one included', () => {
    const pages = [
      page([update({ id: 'a' }), update({ id: 'b' })], { nextCursor: 'cursor-2' }),
      page([update({ id: 'b' }), update({ id: 'c' })], { latestAt: null }),
    ];
    expect(supportUpdatesFromPages(pages).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(supportUpdatesFromPages(undefined)).toEqual([]);
  });

  it('takes the newest update\'s time from the first page, and says nothing until it has loaded', () => {
    expect(supportUpdatesLatestAt(undefined)).toBeUndefined();
    expect(supportUpdatesLatestAt([page([], { latestAt: null })])).toBeNull();
    expect(supportUpdatesLatestAt([contractPage])).toBe('2026-11-26T12:00:00.000Z');
  });

  it('reads the end of the list from a missing cursor', () => {
    expect(supportUpdatesNextCursor(page([], { nextCursor: 'cursor-2' }))).toBe('cursor-2');
    expect(supportUpdatesNextCursor(page([], { nextCursor: null }))).toBeUndefined();
  });

  it('draws the contract\'s update as its card says it', () => {
    const card = supportUpdateCard(contractPage.updates[0], new Date('2026-11-26T18:00:00.000Z'));
    expect(card).toEqual({
      id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a',
      kind: 'announcement',
      kindLabel: 'Announcement',
      title: 'Folders are here',
      dateLabel: 'Today',
      preview: 'Group your creations into folders from your profile. Tell us what you think in the comments.',
      commentWords: '4 comments',
      commentsLocked: false,
      accessibilityLabel: 'Announcement, Folders are here, Today. Group your creations into folders from your profile. Tell us what you think in the comments.',
      reactions: { reactions: { '👍': 12, '❤️': 3 }, myReaction: '👍' },
    });
  });

  it('calls a shipped update New, and says when its comments are off', () => {
    const card = supportUpdateCard(update({ kind: 'shipped', commentsLocked: true }), new Date('2026-11-27T12:00:00.000Z'));
    expect(card.kindLabel).toBe('New');
    expect(card.dateLabel).toBe('Yesterday');
    expect(card.commentWords).toBe('Comments are off');
    expect(card.commentsLocked).toBe(true);
  });
});

describe('reactions', () => {
  const state: SupportHubReactionState = { reactions: { '👍': 2, '❤️': 1 }, myReaction: '👍' };

  it('takes the reader\'s own away when pressed again, and makes any other theirs', () => {
    expect(supportHubReactionTarget('👍', '👍')).toBeNull();
    expect(supportHubReactionTarget('👍', '❤️')).toBe('❤️');
    expect(supportHubReactionTarget(null, '🙏')).toBe('🙏');
  });

  it('draws a change at once: one person moves from the old reaction to the new', () => {
    expect(supportHubReactionDrawn(state, '❤️')).toEqual({ reactions: { '👍': 1, '❤️': 2 }, myReaction: '❤️' });
    expect(supportHubReactionDrawn(state, null)).toEqual({ reactions: { '👍': 1, '❤️': 1 }, myReaction: null });
    expect(supportHubReactionDrawn({ reactions: { '❤️': 1 }, myReaction: '❤️' }, null)).toEqual({ reactions: {}, myReaction: null });
  });

  it('chips each reaction someone chose, the reader\'s marked, with what a press does', () => {
    expect(supportHubReactionChipsOf(state, true)).toEqual([
      { emoji: '👍', count: 2, mine: true, label: '👍, 2 people, yours', hint: 'Takes your reaction away' },
      { emoji: '❤️', count: 1, mine: false, label: '❤️, 1 person', hint: 'Changes your reaction to ❤️' },
    ]);
    expect(supportHubReactionChipsOf({ reactions: { '😂': 4 }, myReaction: null }, true)[0].hint).toBe('Reacts with 😂');
    // A guest's press asks them to sign up.
    expect(supportHubReactionChipsOf(state, false).map((chip) => chip.hint)).toEqual(['Sign in to react', 'Sign in to react']);
  });

  it('patches the update wherever its page is, and leaves the data alone when it holds no such update', () => {
    const data: InfiniteData<SupportUpdatesPage> = {
      pages: [page([update({ id: 'a' })]), page([update({ id: 'b' })])],
      pageParams: [null, 'cursor-2'],
    };
    const next = withSupportUpdateReaction(data, 'b', { reactions: { '🙏': 1 }, myReaction: '🙏' });
    expect(next?.pages[1].updates[0]).toMatchObject({ id: 'b', reactions: { '🙏': 1 }, myReaction: '🙏' });
    expect(next?.pages[0]).toBe(data.pages[0]);
    expect(next?.pageParams).toBe(data.pageParams);
    expect(withSupportUpdateReaction(data, 'missing', { reactions: {}, myReaction: null })).toBe(data);
    expect(withSupportUpdateReaction(undefined, 'a', { reactions: {}, myReaction: null })).toBeUndefined();
  });

  it('patches a roadmap item the same way', () => {
    const next = withSupportRoadmapReaction(contractRoadmap, contractRoadmap.items[0].id, { reactions: { '🙏': 41 }, myReaction: '🙏' });
    expect(next?.items[0]).toMatchObject({ reactions: { '🙏': 41 }, myReaction: '🙏' });
    expect(next?.items[1]).toBe(contractRoadmap.items[1]);
    expect(withSupportRoadmapReaction(contractRoadmap, 'missing', { reactions: {}, myReaction: null })).toBe(contractRoadmap);
  });

  it('titles the picker with what is being reacted to, cut to one line', () => {
    expect(supportHubReactionSheetTitle('Folders are here')).toBe('Folders are here');
    expect(supportHubReactionSheetTitle('   ')).toBe('React');
    const long = supportHubReactionSheetTitle('a'.repeat(80));
    expect(Array.from(long)).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('a reaction on its way', () => {
  function reactor() {
    const sends: Array<{ id: string; emoji: string | null; answer: ReturnType<typeof deferred<SupportHubReactionResponse>> }> = [];
    const drawn: Array<{ id: string; state: SupportHubReactionState }> = [];
    const failed = vi.fn();
    const subject = createSupportHubReactor({
      send: (id, emoji) => {
        const answer = deferred<SupportHubReactionResponse>();
        sends.push({ id, emoji, answer });
        return answer.promise;
      },
      draw: (id, state) => drawn.push({ id, state }),
      failed,
    });
    return { subject, sends, drawn, failed };
  }

  const none: SupportHubReactionState = { reactions: { '👍': 3 }, myReaction: null };

  it('is drawn at once, and the answer replaces the guess', async () => {
    const { subject, sends, drawn } = reactor();
    subject.press('update-1', none, '👍');

    expect(drawn.at(-1)).toEqual({ id: 'update-1', state: { reactions: { '👍': 4 }, myReaction: '👍' } });
    expect(sends.map(({ id, emoji }) => [id, emoji])).toEqual([['update-1', '👍']]);

    // Someone else reacted meanwhile: the server's counts win.
    sends[0].answer.resolve({ reactions: { '👍': 5 }, myReaction: '👍' });
    await flush();
    expect(drawn.at(-1)).toEqual({ id: 'update-1', state: { reactions: { '👍': 5 }, myReaction: '👍' } });
  });

  it('puts back what the server held when it is refused, and says which item', async () => {
    const { subject, sends, drawn, failed } = reactor();
    subject.press('update-1', none, '👍');
    const refusal = new Error('offline');
    sends[0].answer.reject(refusal);
    await flush();

    expect(drawn.at(-1)).toEqual({ id: 'update-1', state: none });
    expect(failed).toHaveBeenCalledWith('update-1', refusal);
  });

  it('sends a press made while one is on its way when that one lands, the latest press kept', async () => {
    const { subject, sends, drawn } = reactor();
    subject.press('update-1', none, '👍');
    // Drawn at once, sent later: from what the screen now shows.
    subject.press('update-1', drawn.at(-1)!.state, '👍');
    subject.press('update-1', drawn.at(-1)!.state, '❤️');
    expect(drawn.at(-1)?.state).toEqual({ reactions: { '👍': 3, '❤️': 1 }, myReaction: '❤️' });
    expect(sends).toHaveLength(1);

    sends[0].answer.resolve({ reactions: { '👍': 4 }, myReaction: '👍' });
    await flush();
    // The press that waited is drawn over the answer and sent.
    expect(drawn.at(-1)?.state).toEqual({ reactions: { '👍': 3, '❤️': 1 }, myReaction: '❤️' });
    expect(sends.map(({ emoji }) => emoji)).toEqual(['👍', '❤️']);

    sends[1].answer.resolve({ reactions: { '👍': 3, '❤️': 1 }, myReaction: '❤️' });
    await flush();
    expect(drawn.at(-1)?.state).toEqual({ reactions: { '👍': 3, '❤️': 1 }, myReaction: '❤️' });
  });

  it('sends nothing more when the press that waited is what the server already holds', async () => {
    const { subject, sends } = reactor();
    subject.press('update-1', none, '👍');
    subject.press('update-1', { reactions: { '👍': 4 }, myReaction: '👍' }, '👍');
    subject.press('update-1', { reactions: { '👍': 3 }, myReaction: null }, '👍');

    sends[0].answer.resolve({ reactions: { '👍': 4 }, myReaction: '👍' });
    await flush();
    expect(sends).toHaveLength(1);
  });

  it('puts back the last answer when the press that waited is refused', async () => {
    const { subject, sends, drawn, failed } = reactor();
    subject.press('update-1', none, '👍');
    subject.press('update-1', drawn.at(-1)!.state, '❤️');
    sends[0].answer.resolve({ reactions: { '👍': 4 }, myReaction: '👍' });
    await flush();
    sends[1].answer.reject(new Error('offline'));
    await flush();

    expect(drawn.at(-1)?.state).toEqual({ reactions: { '👍': 4 }, myReaction: '👍' });
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('keeps each item\'s presses to itself', async () => {
    const { subject, sends } = reactor();
    subject.press('update-1', none, '👍');
    subject.press('update-2', none, '😂');
    expect(sends.map(({ id, emoji }) => [id, emoji])).toEqual([['update-1', '👍'], ['update-2', '😂']]);
  });
});

describe('the roadmap', () => {
  const now = Date.parse('2026-11-26T12:00:00.000Z');

  it('groups the contract\'s items as Building then Shipped recently, with votes and the update a shipped one names', () => {
    const sections = supportRoadmapSections(contractRoadmap.items, now);
    expect(sections.map((section) => [section.status, section.heading])).toEqual([
      ['building', 'Building'],
      ['shipped', 'Shipped recently'],
    ]);
    expect(sections[0].items[0]).toEqual({
      id: '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b',
      title: 'Folders for creations',
      summary: 'Group what you make by project.',
      voteWords: '58 people want this',
      reactions: { reactions: { '🙏': 40, '👍': 18 }, myReaction: null },
      readUpdateId: null,
    });
    expect(sections[1].items[0]).toMatchObject({ voteWords: '9 people want this', readUpdateId: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' });
  });

  it('puts Building before Exploring, and leaves out a shipped item past its thirty days', () => {
    const sections = supportRoadmapSections([
      item({ id: 'explore', status: 'exploring' }),
      item({ id: 'build', status: 'building' }),
      item({ id: 'old', status: 'shipped', shippedAt: '2026-10-01T00:00:00.000Z', shippedUpdateId: 'update-1' }),
    ], now);
    expect(sections.map((section) => section.status)).toEqual(['building', 'exploring']);
    expect(sections[1].items[0]).toMatchObject({ voteWords: 'No votes yet', readUpdateId: null });
  });

  it('lays the sections out as rows: each heading, then its items', () => {
    const rows = supportRoadmapRows(supportRoadmapSections(contractRoadmap.items, now));
    expect(rows.map((row) => (row.kind === 'heading' ? `${row.heading}${row.first ? ' (first)' : ''}` : row.card.title))).toEqual([
      'Building (first)',
      'Folders for creations',
      'Shipped recently',
      'Text posts',
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

describe('the unread dot', () => {
  it('reads a kept marker as a time, and anything else as no look yet', () => {
    expect(readSupportUpdatesSeenAt('2026-11-26T12:00:00.000Z')).toBe('2026-11-26T12:00:00.000Z');
    expect(readSupportUpdatesSeenAt('yesterday-ish')).toBeNull();
    expect(readSupportUpdatesSeenAt(42)).toBeNull();
    expect(readSupportUpdatesSeenAt(null)).toBeNull();
  });

  it('shows the dot for an update newer than the last look, and none before the marker is read', () => {
    const latest = '2026-11-26T12:00:00.000Z';
    expect(supportHubUnseenUpdates(latest, { loaded: true, seenAt: null })).toBe(true);
    expect(supportHubUnseenUpdates(latest, { loaded: true, seenAt: '2026-11-25T12:00:00.000Z' })).toBe(true);
    expect(supportHubUnseenUpdates(latest, { loaded: true, seenAt: latest })).toBe(false);
    expect(supportHubUnseenUpdates(latest, { loaded: false, seenAt: null })).toBe(false);
    expect(supportHubUnseenUpdates(null, { loaded: true, seenAt: null })).toBe(false);
  });

  it('keeps the newest look, never an earlier one', () => {
    expect(supportUpdatesSeenToKeep('2026-11-26T12:00:00.000Z', null)).toBe('2026-11-26T12:00:00.000Z');
    expect(supportUpdatesSeenToKeep('2026-11-26T12:00:00.000Z', '2026-11-20T12:00:00.000Z')).toBe('2026-11-26T12:00:00.000Z');
    expect(supportUpdatesSeenToKeep('2026-11-20T12:00:00.000Z', '2026-11-26T12:00:00.000Z')).toBeNull();
    expect(supportUpdatesSeenToKeep('2026-11-26T12:00:00.000Z', '2026-11-26T12:00:00.000Z')).toBeNull();
    expect(supportUpdatesSeenToKeep(null, '2026-11-26T12:00:00.000Z')).toBeNull();
    expect(supportUpdatesSeenToKeep('not a time', null)).toBeNull();
  });
});
