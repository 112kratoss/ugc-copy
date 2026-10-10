import type { BlockedUser } from './api-client';

/**
 * Settings → Blocked users. The words of the screen and of its question, kept
 * here so that they can be tested without drawing it.
 */

export const BLOCKED_USERS_EMPTY_TITLE = 'You have not blocked anyone';
export const BLOCKED_USERS_EMPTY_BODY =
  'Block someone from the menu on their post or their profile, and they will be listed here.';
export const BLOCKED_USERS_MORE_NOTE =
  'Showing your most recent blocks. Unblock someone to see the ones before them.';
export const UNBLOCK_CONFIRM_MESSAGE =
  'Their posts will return to your feeds, and you can follow each other again.';

/** The key of the list in the query cache: one list per signed-in account. */
export function blockedUsersQueryKey(viewerId: string | null | undefined) {
  return ['blocked-users', viewerId ?? null] as const;
}

/** `@handle`, as a card names its creator; their name when they have no handle. */
export function blockedUserLabel(user: Pick<BlockedUser, 'username' | 'name'>): string {
  const handle = user.username?.trim();
  return handle ? `@${handle}` : user.name;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 10, 2026" in the phone's own day, or nothing for a time that cannot be read. */
export function formatBlockedDate(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Written out, not `toLocaleDateString`: Hermes builds differ in the locale
  // data they carry, and this line has to read the same on every phone.
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * The lines under the name, each on its own: the handle, then the day. On one
 * line a phone cut the day off ("@studio-north · Blocked Oct …"), and the day
 * is what tells two blocks apart.
 */
export function blockedUserDetailLines(user: Pick<BlockedUser, 'username' | 'blockedAt'>): string[] {
  const handle = user.username?.trim();
  const blockedOn = formatBlockedDate(user.blockedAt);
  return [handle ? `@${handle}` : null, blockedOn ? `Blocked ${blockedOn}` : null]
    .filter((line): line is string => Boolean(line));
}

/**
 * The rows to draw: the list as the server gave it, without the people whose
 * unblock has been answered "yes". They are left out, not taken off the list:
 * when the server refuses, taking the id out again puts the row back in its
 * place, whoever else was unblocked meanwhile.
 */
export function visibleBlockedUsers(blockedUsers: BlockedUser[], unblockedIds: ReadonlySet<string>): BlockedUser[] {
  return unblockedIds.size === 0 ? blockedUsers : blockedUsers.filter((user) => !unblockedIds.has(user.id));
}

/** The saved list without one person, once the server has unblocked them: what the screen opens with next time. */
export function withoutBlockedUser<TList extends { blockedUsers: BlockedUser[] }>(
  list: TList | undefined,
  userId: string,
): TList | undefined {
  return list ? { ...list, blockedUsers: list.blockedUsers.filter((user) => user.id !== userId) } : list;
}
