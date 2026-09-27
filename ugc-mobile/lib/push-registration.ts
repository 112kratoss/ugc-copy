import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { MagicbookletApiClient } from './api-client';
import { registerForMobilePushNotifications, type MobilePushRegistrationResult } from './notifications';

/**
 * This device's push state for one account. The sign-in sync in `lib/auth.tsx`,
 * the Alerts screen and the push offers all read and write this one entry, so
 * turning notifications on anywhere shows everywhere at once.
 */
export function devicePushQueryKey(userId: string | null | undefined) {
  return ['mobile-push-registration', userId] as const;
}

export type DevicePushRegistration = {
  /** Null until the first check settles. */
  result: MobilePushRegistrationResult | null;
  isLoading: boolean;
  /** The check itself failed, e.g. the token could not be uploaded. */
  checkFailed: boolean;
  recheck: () => void;
  /** Asks the OS for permission, then registers the token. Never throws. */
  enable: () => void;
  isEnabling: boolean;
  enableError: Error | null;
};

/**
 * Checking never asks for permission; `enable` does. Enabling runs as a
 * mutation, so a failure becomes `enableError` for the caller to show instead
 * of a rejected promise nobody handles.
 */
export function useDevicePushRegistration({
  api,
  userId,
}: {
  api: MagicbookletApiClient;
  /** Null skips the check, e.g. for a guest, who cannot register a token. */
  userId: string | null | undefined;
}): DevicePushRegistration {
  const queryClient = useQueryClient();
  const queryKey = devicePushQueryKey(userId);

  const query = useQuery({
    queryKey,
    enabled: Boolean(userId),
    queryFn: () => registerForMobilePushNotifications(api, { requestPermission: false }),
    staleTime: 1000 * 30,
  });

  const mutation = useMutation({
    mutationFn: () => registerForMobilePushNotifications(api, { requestPermission: true }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
    },
    onError: (error) => {
      console.error('Failed to register mobile push notifications', error);
    },
  });

  return {
    // The query alone, not `mutation.data ?? query.data`: enabling writes its
    // result into the query, and a later check (say, after notifications were
    // turned off in Settings) must be able to replace it.
    result: query.data ?? null,
    isLoading: query.isLoading,
    checkFailed: query.isError,
    recheck: () => void query.refetch(),
    enable: () => mutation.mutate(),
    isEnabling: mutation.isPending,
    enableError: mutation.error,
  };
}
