import type { QueryClient } from '@tanstack/react-query';

/**
 * The unread count behind the Alerts tab's badge.
 *
 * Tab bars: "Use a badge to indicate that critical information is available.
 * You can display a badge — a red oval containing white text and either a
 * number or an exclamation point — on a tab to indicate that there's new or
 * updated information in the section that warrants a person's attention."
 *
 * The Studio screen already knew its unread count and printed it in its own
 * header; the tab that leads there did not, so an arriving notification was
 * invisible from every other tab. This module is the shared source for both.
 *
 * It deliberately does *not* reuse Studio's `['mobile-notifications', userId]`
 * query. That one pulls 50 notifications and lives as long as the Studio screen
 * is mounted; the tab bar is mounted for the entire session, and re-fetching a
 * 50-item payload from every tab for one integer is exactly the kind of idle
 * egress this backend cannot spend. The badge asks for one row instead — the
 * server sends `unreadCount` regardless of `limit` — and Studio pushes its own
 * fresher count into this cache whenever it has one.
 */
export const NOTIFICATION_BADGE_QUERY_KEY = 'mobile-notification-badge';

/** Above this the oval would grow wider than the tab slot it sits in. */
export const MAX_BADGE_COUNT = 99;

export function notificationBadgeQueryKey(userId: string | undefined) {
  return [NOTIFICATION_BADGE_QUERY_KEY, userId] as const;
}

/**
 * `null` means "draw nothing" — an empty badge is worse than no badge, and HIG
 * reserves the oval for information that actually warrants attention. Counts
 * past the cap read as "99+" rather than growing the oval.
 */
export function formatBadgeCount(count: number | undefined | null): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  const whole = Math.floor(count);
  if (whole <= 0) return null;
  return whole > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(whole);
}

/**
 * Called by Studio whenever it learns a truer count than the badge's own poll —
 * on load, and after marking one or all notifications read. Marking read is the
 * moment the badge must drop, and waiting out `staleTime` to discover that
 * leaves a stale number on screen while the user watches.
 */
export function publishUnreadCount(
  queryClient: QueryClient,
  userId: string | undefined,
  unreadCount: number
) {
  queryClient.setQueryData(notificationBadgeQueryKey(userId), unreadCount);
}
