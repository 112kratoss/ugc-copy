import { describe, expect, it } from 'vitest';

import {
  appendSupportUpdates,
  applySupportHubReaction,
  groupSupportRoadmapItems,
  hasUnseenSupportUpdates,
  readSupportHubReactionCounts,
  readSupportHubReactionRequest,
  readSupportHubTab,
  readSupportRoadmapResponse,
  readSupportUpdatesPage,
  supportHubPath,
  supportHubReactionChips,
  supportHubReactionPeople,
  supportRoadmapShippedAlertWords,
  supportUpdateAlertWords,
  supportUpdateCommentWords,
  supportUpdateDateLabel,
  supportUpdatePreview,
  supportUpdatesSeenValue,
  type SupportRoadmapItem,
} from '../../ugc-mobile/lib/support-hub-policy/support-hub-policy';
import mobileApiContract from '../../contracts/mobile-api-v1.json';

const endpoints = mobileApiContract.endpoints;

describe('support hub tabs', () => {
  it('opens on the chat and reads only its three tabs', () => {
    expect(readSupportHubTab(undefined)).toBe('chat');
    expect(readSupportHubTab('updates')).toBe('updates');
    expect(readSupportHubTab(['roadmap'])).toBe('roadmap');
    expect(readSupportHubTab('admin')).toBe('chat');
    expect(supportHubPath('chat')).toBe('/support');
    expect(supportHubPath('updates')).toBe('/support?tab=updates');
  });
});

describe('reactions', () => {
  it('reads a request and counts only quick reactions', () => {
    expect(readSupportHubReactionRequest({ emoji: '👍' })).toEqual({ emoji: '👍' });
    expect(readSupportHubReactionRequest({ emoji: null })).toEqual({ emoji: null });
    expect(readSupportHubReactionRequest({ emoji: '🎃' })).toBeNull();
    expect(readSupportHubReactionRequest({})).toBeNull();
    expect(readSupportHubReactionCounts({ '👍': 2, '🎃': 4, '❤️': 0, '🙏': 1.5 })).toEqual({ '👍': 2 });
  });

  it('moves a reader\'s reaction at once and counts people', () => {
    const counts = { '👍': 2, '❤️': 1 };
    expect(applySupportHubReaction(counts, null, '👍')).toEqual({ '👍': 3, '❤️': 1 });
    expect(applySupportHubReaction(counts, '❤️', '👍')).toEqual({ '👍': 3 });
    expect(applySupportHubReaction(counts, '👍', null)).toEqual({ '👍': 1, '❤️': 1 });
    expect(supportHubReactionPeople(counts)).toBe(3);
    expect(supportHubReactionChips({ '🙏': 1, '👍': 2 })).toEqual([{ emoji: '👍', count: 2 }, { emoji: '🙏', count: 1 }]);
  });
});

describe('updates', () => {
  it('reads the contract\'s page and appends without repeats', () => {
    const page = readSupportUpdatesPage(endpoints.getSupportUpdates.response);
    expect(page?.updates[0]).toMatchObject({ kind: 'announcement', myReaction: '👍', reactions: { '👍': 12, '❤️': 3 } });
    expect(page?.latestAt).toBe('2026-11-26T12:00:00.000Z');
    const updates = page?.updates ?? [];
    expect(appendSupportUpdates(updates, updates)).toHaveLength(1);
    expect(readSupportUpdatesPage({ updates: [{ id: 'x', kind: 'rumour', createdAt: '2026-11-26' }] })?.updates).toEqual([]);
    expect(readSupportUpdatesPage(null)).toBeNull();
  });

  it('shows the unread dot only for an update newer than the last look', () => {
    expect(hasUnseenSupportUpdates(null, null)).toBe(false);
    expect(hasUnseenSupportUpdates('2026-11-26T12:00:00Z', null)).toBe(true);
    expect(hasUnseenSupportUpdates('2026-11-26T12:00:00Z', '2026-11-26T12:00:00Z')).toBe(false);
    expect(hasUnseenSupportUpdates('2026-11-26T12:00:01Z', '2026-11-26T12:00:00Z')).toBe(true);
    expect(supportUpdatesSeenValue('2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z')).toBe('2026-11-26T00:00:00Z');
    expect(supportUpdatesSeenValue(null, '2026-11-26T00:00:00Z')).toBe('2026-11-26T00:00:00Z');
  });

  it('cuts a preview at a word and says the comments and the date', () => {
    expect(supportUpdatePreview('alpha beta gamma delta', 13)).toBe('alpha beta…');
    expect(supportUpdatePreview('one\n\ntwo', 20)).toBe('one two');
    expect(supportUpdatePreview('short')).toBe('short');
    expect(supportUpdateCommentWords(0, true)).toBe('Comments are off');
    expect(supportUpdateCommentWords(1, false)).toBe('1 comment');
    expect(supportUpdateCommentWords(1200, false)).toBe('1,200 comments');
    const now = new Date(2026, 10, 26, 15, 0);
    expect(supportUpdateDateLabel(new Date(2026, 10, 26, 9, 0).toISOString(), now)).toBe('Today');
    expect(supportUpdateDateLabel(new Date(2026, 10, 25, 23, 0).toISOString(), now)).toBe('Yesterday');
    expect(supportUpdateDateLabel(new Date(2026, 9, 3, 12, 0).toISOString(), now)).toBe('3 Oct');
    expect(supportUpdateDateLabel(new Date(2025, 11, 31, 12, 0).toISOString(), now)).toBe('31 Dec 2025');
  });

  it('words the alerts', () => {
    expect(supportUpdateAlertWords('shipped', 'Folders are here')).toEqual({ title: 'New on Magicbooklet', body: 'Folders are here' });
    expect(supportUpdateAlertWords('announcement', '  ')).toEqual({ title: 'News from Magicbooklet', body: 'Open it to read more.' });
    expect(supportRoadmapShippedAlertWords('Folders')).toEqual({ title: 'You asked, it’s live', body: 'Folders is here. Take a look.' });
  });
});

describe('roadmap', () => {
  it('groups Building, Exploring, then what shipped in the last thirty days', () => {
    const now = Date.parse('2026-11-26T00:00:00Z');
    const item = (id: string, status: SupportRoadmapItem['status'], shippedAt: string | null = null): SupportRoadmapItem => ({
      id, title: id, summary: '', status, shippedAt, shippedUpdateId: null, reactions: {}, myReaction: null,
    });
    const groups = groupSupportRoadmapItems([
      item('a', 'exploring'),
      item('b', 'building'),
      item('c', 'shipped', '2026-11-20T00:00:00Z'),
      item('d', 'shipped', '2026-09-01T00:00:00Z'),
    ], now);
    expect(groups.map((group) => [group.status, group.items.map((entry) => entry.id)])).toEqual([
      ['building', ['b']],
      ['exploring', ['a']],
      ['shipped', ['c']],
    ]);
    expect(readSupportRoadmapResponse(endpoints.getSupportRoadmap.response)?.items.map((entry) => entry.status)).toEqual(['building', 'shipped']);
  });
});
