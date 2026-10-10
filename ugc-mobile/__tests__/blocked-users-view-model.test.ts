import { describe, expect, it } from 'vitest';

import {
  blockedUserDetailLines,
  blockedUserLabel,
  blockedUsersQueryKey,
  formatBlockedDate,
  visibleBlockedUsers,
  withoutBlockedUser,
} from '../lib/blocked-users-view-model';

const user = (overrides: Partial<{ id: string; username: string | null; name: string; avatar: string | null; blockedAt: string }> = {}) => ({
  id: 'creator-1',
  username: 'first-creator',
  name: 'First Creator',
  avatar: null,
  blockedAt: '2026-10-10T08:00:00.000Z',
  ...overrides,
});

describe('blocked users', () => {
  it('names someone by handle, as a card names its creator, and by name when they have none', () => {
    expect(blockedUserLabel(user())).toBe('@first-creator');
    expect(blockedUserLabel(user({ username: null }))).toBe('First Creator');
    expect(blockedUserLabel(user({ username: '   ' }))).toBe('First Creator');
  });

  it('writes the day a block was made the same way on every phone', () => {
    // Noon UTC is the same calendar day in every time zone a phone can be in.
    expect(formatBlockedDate('2026-10-10T12:00:00.000Z')).toBe('Oct 10, 2026');
    expect(formatBlockedDate('2026-01-05T12:00:00.000Z')).toBe('Jan 5, 2026');
    expect(formatBlockedDate('not a date')).toBeNull();
    expect(formatBlockedDate('')).toBeNull();
  });

  // On one line a phone cut the day off ("@studio-north · Blocked Oct …", seen on
  // the Pixel 9a emulator), and the day is what tells two blocks apart.
  it('puts the handle and the day under the name on lines of their own, whichever of them there is', () => {
    expect(blockedUserDetailLines(user({ blockedAt: '2026-10-10T12:00:00.000Z' }))).toEqual(['@first-creator', 'Blocked Oct 10, 2026']);
    expect(blockedUserDetailLines(user({ username: null, blockedAt: '2026-10-10T12:00:00.000Z' }))).toEqual(['Blocked Oct 10, 2026']);
    expect(blockedUserDetailLines(user({ blockedAt: 'not a date' }))).toEqual(['@first-creator']);
    expect(blockedUserDetailLines(user({ username: null, blockedAt: 'not a date' }))).toEqual([]);
  });

  it('keeps one list per signed-in account', () => {
    expect(blockedUsersQueryKey('user-1')).toEqual(['blocked-users', 'user-1']);
    expect(blockedUsersQueryKey(undefined)).toEqual(['blocked-users', null]);
    expect(blockedUsersQueryKey('user-1')).not.toEqual(blockedUsersQueryKey('user-2'));
  });

  it('takes one person out of the list and leaves the rest of the answer as it was', () => {
    const list = { success: true as const, hasMore: true, blockedUsers: [user(), user({ id: 'creator-2' })] };

    expect(withoutBlockedUser(list, 'creator-1')).toEqual({ success: true, hasMore: true, blockedUsers: [user({ id: 'creator-2' })] });
    expect(withoutBlockedUser(list, 'nobody')?.blockedUsers).toHaveLength(2);
    expect(withoutBlockedUser(undefined, 'creator-1')).toBeUndefined();
  });

  it('leaves out the people being unblocked and keeps the rest in the order the server gave', () => {
    const list = [user(), user({ id: 'creator-2' }), user({ id: 'creator-3' })];

    expect(visibleBlockedUsers(list, new Set(['creator-2'])).map((entry) => entry.id)).toEqual(['creator-1', 'creator-3']);
    expect(visibleBlockedUsers(list, new Set(['creator-3', 'creator-1'])).map((entry) => entry.id)).toEqual(['creator-2']);
    // Someone who is not on the list changes nothing, and neither does nobody: the same list, not a copy.
    expect(visibleBlockedUsers(list, new Set(['nobody']))).toEqual(list);
    expect(visibleBlockedUsers(list, new Set())).toBe(list);
  });
});
