import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/lib/auth';
import { formatBadgeCount, notificationBadgeQueryKey } from '@/lib/notification-badge';

/**
 * The React half of the Alerts badge. It lives apart from the formatting and
 * cache-key logic in `notification-badge.ts` for the reason every
 * `lib/*-view-model.ts` module does: reaching `useAuth` drags expo-constants and
 * the rest of the native chain in behind it, and the guard test that sweeps the
 * tree for badge rules has no business booting Expo to read a number.
 */
export function useUnreadNotificationCount(): number {
  const { user, api } = useAuth();

  const query = useQuery({
    queryKey: notificationBadgeQueryKey(user?.id),
    enabled: Boolean(user),
    queryFn: async () => {
      const response = await api.listMobileNotifications({ limit: 1 });
      return response?.unreadCount ?? 0;
    },
    // A minute is the slowest a badge can lag without feeling broken, and the
    // slowest this can poll without becoming a background cost of its own.
    staleTime: 1000 * 60,
  });

  return query.data ?? 0;
}

/**
 * Test seam: the tab bar renders under a mocked react-query in the focused
 * component tests, where the hook above would need an auth provider it has no
 * reason to build. Keeping the read in one named export lets those tests swap
 * it without reaching into the query client.
 */
export function useTabBarBadge(): string | null {
  return formatBadgeCount(useUnreadNotificationCount());
}
