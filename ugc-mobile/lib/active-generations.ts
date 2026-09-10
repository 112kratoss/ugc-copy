import type { QueryClient } from '@tanstack/react-query';

/**
 * How many of the viewer's runs are still working, behind the create control's
 * ring. Split from `use-active-generations.ts` exactly the way
 * `notification-badge.ts` is split from its hook: the hook reaches `useAuth`,
 * which drags expo-constants and the native chain in behind it, and the code
 * that merely needs to say "a run just started" has no business booting Expo.
 * Vitest cannot parse react-native's entry point, so that import chain is the
 * difference between a testable module and one that needs the whole platform
 * mocked.
 */
export function activeGenerationsQueryKey(userId: string | null | undefined) {
  return ['active-generations', userId] as const;
}

/**
 * Tell the ring a run just started.
 *
 * Required precisely because the poll is a function of its own answer: at a
 * count of zero the refetch interval is `false`, so no request is in flight to
 * notice the new run, and the tab bar never unmounts to refetch on mount.
 * Without this the ring would not appear until the app next returned to the
 * foreground — dark through the one session that matters, the one where the
 * person just pressed Create.
 *
 * Invalidating rather than incrementing a cached number on purpose: the server
 * decides what counts as in flight, and a start the backend later rejects would
 * leave an optimistic count stuck above zero, polling forever.
 */
export function invalidateActiveGenerations(
  queryClient: QueryClient,
  userId: string | null | undefined,
) {
  void queryClient.invalidateQueries({ queryKey: activeGenerationsQueryKey(userId) });
}
