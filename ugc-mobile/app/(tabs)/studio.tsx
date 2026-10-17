import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useFocusEffect, useScrollToTop } from '@react-navigation/native';
import { router } from 'expo-router';
import {
  BellRing,
  CheckCheck,
  CheckCircle2,
  Clock3,
  CreditCard,
  Heart,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  WandSparkles,
} from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TopScrim } from '@/components/top-scrim';
import { AppText, Card, IconButton, PrimaryButton, SecondaryButton, StatusBlock } from '@/components/ui';
import { haptic } from '@/lib/haptics';
import { formatRelativeTime } from '@/lib/home-view-model';
import { useAuth } from '@/lib/auth';
import { alertsListQueryKey, publishUnreadCount } from '@/lib/notification-badge';
import {
  ALERTS_ROUTE,
  deepLinkTargetsAlertsScreen,
  navigateToNotificationDeepLink,
  setAlertsScreenFocused,
  type MobilePushRegistrationResult,
} from '@/lib/notifications';
import { useDevicePushRegistration } from '@/lib/push-registration';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { hexWithAlpha } from '@/lib/eased-fade';
import { appTheme, type ThemeColorName } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type {
  MobileNotification,
  MobileNotificationCategory,
  MobileNotificationPreferences as PreferenceState,
  MobileNotificationsResponse,
} from '@/lib/types';

const NOTIFICATION_CATEGORIES = [
  {
    title: 'Generation updates',
    body: 'Finished renders, failed runs, and long-running jobs land here first.',
    icon: WandSparkles,
    tone: 'motion',
  },
  {
    title: 'Creator activity',
    body: 'New followers, saves, remixes, and authenticated shares are grouped into a quieter history.',
    icon: Heart,
    tone: 'danger',
  },
  {
    title: 'Recipes & credits',
    body: 'Credit purchases, restores, and recipe unlocks stay visible after the push fades.',
    icon: CreditCard,
    tone: 'amber',
  },
] as const;

// Tones are colour names, resolved against the scheme's palette when a row draws.
const CATEGORY_META: Record<MobileNotificationCategory, { tone: ThemeColorName; label: string; Icon: typeof BellRing }> = {
  generation: { tone: 'motion', label: 'Generation', Icon: WandSparkles },
  commerce: { tone: 'amber', label: 'Unlocks', Icon: CreditCard },
  social: { tone: 'danger', label: 'Creator', Icon: Heart },
  system: { tone: 'info', label: 'System', Icon: BellRing },
};

/** Alerts per read: the newest page, then each older one the reader asks for. */
const ALERTS_PAGE_SIZE = 50;
/** A list read longer ago than this is read again when the tab comes back into view. */
const ALERTS_STALE_MS = 1000 * 20;

/**
 * The server's `before` cursor for the next older page: the last event time of
 * the oldest alert held, the time the list is ordered by. A page shorter than
 * asked for was the end of the list.
 */
function olderAlertsCursor(lastPage: MobileNotificationsResponse): OlderAlertsCursor | undefined {
  const alerts = lastPage.notifications;
  const oldest = alerts[alerts.length - 1];
  // The id beside the time: alerts sharing the boundary time would otherwise
  // be skipped by a time-only cursor.
  return alerts.length < ALERTS_PAGE_SIZE || !oldest ? undefined : { before: oldest.updatedAt, beforeId: oldest.id };
}

type OlderAlertsCursor = { before: string; beforeId: string };

/**
 * Every page in the order read, each alert once, whatever the server does with
 * alerts that share the boundary time.
 */
function flattenAlertPages(data: InfiniteData<MobileNotificationsResponse> | undefined) {
  const seen = new Set<string>();
  const alerts: MobileNotification[] = [];
  for (const page of data?.pages ?? []) {
    for (const notification of page.notifications) {
      if (seen.has(notification.id)) continue;
      seen.add(notification.id);
      alerts.push(notification);
    }
  }
  return alerts;
}

export default function StudioScreen() {
  const theme = useAppTheme();
  const { user, api } = useAuth();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const pageWidth = Math.min(width, 430);
  const isCompact = pageWidth < 390;
  const horizontalPadding = isCompact ? 16 : 18;
  const queryKey = alertsListQueryKey(user?.id);
  const preferencesQueryKey = ['mobile-notification-preferences', user?.id] as const;

  // The unread count covers every alert, and unread ones are never pruned, so
  // the list pages on past its newest 50: "72 unread" over a list of 50 left
  // the rest out of reach.
  const notificationsQuery = useInfiniteQuery({
    queryKey,
    enabled: Boolean(user),
    initialPageParam: null as OlderAlertsCursor | null,
    queryFn: ({ pageParam }) => api.listMobileNotifications({ limit: ALERTS_PAGE_SIZE, before: pageParam?.before ?? null, beforeId: pageParam?.beforeId ?? null }),
    getNextPageParam: olderAlertsCursor,
    staleTime: ALERTS_STALE_MS,
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.markMobileNotificationsRead([id]),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: api.markAllMobileNotificationsRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const preferencesQuery = useQuery({
    queryKey: preferencesQueryKey,
    enabled: Boolean(user),
    queryFn: api.getMobileNotificationPreferences,
    staleTime: 1000 * 60,
  });

  const updatePreferenceMutation = useMutation({
    mutationFn: (patch: Partial<PreferenceState>) => api.updateMobileNotificationPreferences(patch),
    onSuccess: (response) => {
      queryClient.setQueryData(preferencesQueryKey, response);
    },
  });

  const devicePush = useDevicePushRegistration({ api, userId: user?.id });

  // While this list is on screen, an arriving alert is announced by the list
  // itself — a banner over it would repeat what the reader is already looking
  // at. `lib/notifications.ts` reads this when the system asks how to present.
  //
  // Coming back to the tab reads a stale list again, every page held, as the
  // web's Alerts does when its tab regains focus. Before, only a push arriving,
  // the app coming to the front or the Refresh button did.
  const userId = user?.id;
  useFocusEffect(useCallback(() => {
    setAlertsScreenFocused(true);
    const listKey = alertsListQueryKey(userId);
    const listState = queryClient.getQueryState(listKey);
    if (
      listState
      && listState.status !== 'pending'
      && listState.fetchStatus === 'idle'
      && (listState.isInvalidated || Date.now() - listState.dataUpdatedAt >= ALERTS_STALE_MS)
    ) {
      void queryClient.refetchQueries({ queryKey: listKey, exact: true, type: 'active' });
    }
    return () => setAlertsScreenFocused(false);
  }, [queryClient, userId]));

  const notifications = flattenAlertPages(notificationsQuery.data);
  const pages = notificationsQuery.data?.pages;
  // The page read last carries the newest count: a refresh reads every page
  // again from the newest down, and an older page is read after those above it.
  const unreadCount = pages?.[pages.length - 1]?.unreadCount
    ?? notifications.filter((notification) => !notification.isRead).length;
  // The tab bar polls for this number once a minute; this screen learns it
  // first — on load, and again the moment a mark-read refetch lands. Pushing it
  // across means the badge drops as the user watches rather than a minute later.
  useEffect(() => {
    if (notificationsQuery.data) publishUnreadCount(queryClient, user?.id, unreadCount);
  }, [notificationsQuery.data, queryClient, user?.id, unreadCount]);

  const actionError = markReadMutation.error
    ?? markAllReadMutation.error
    ?? updatePreferenceMutation.error
    ?? devicePush.enableError;

  const handlePressNotification = (notification: MobileNotification) => {
    if (!notification.isRead) {
      markReadMutation.mutate(notification.id);
    }

    // Marking it read is the whole of the response when there is nowhere else
    // to go. The row's own destination can be this very screen — "New follower"
    // carries `/studio` when the follower has no handle, as does every one
    // written before the server linked the follower's page — and the old
    // fallback for an unresolvable link asked the router for this screen too.
    if (deepLinkTargetsAlertsScreen(notification.deepLink)) return;
    navigateToNotificationDeepLink(notification.deepLink);
  };

  // Bound to the reader's own pull, never to a background refetch: on iOS a
  // `refreshing` that flips without a drag shifts the list down and can leave
  // it there (the note in components/home-dashboard.tsx).
  const [pullRefreshing, setPullRefreshing] = useState(false);
  // Back to the newest page, then read it again: kept, every older page the
  // reader had opened would be read again as well.
  const refreshNewestAlerts = () => {
    queryClient.setQueryData<InfiniteData<MobileNotificationsResponse, string | null>>(queryKey, (current) => (
      current && current.pages.length > 1
        ? { pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1) }
        : current
    ));
    return notificationsQuery.refetch();
  };
  const handlePullRefresh = () => {
    haptic.light();
    setPullRefreshing(true);
    void refreshNewestAlerts().finally(() => setPullRefreshing(false));
  };
  const loadOlderAlerts = () => {
    if (!notificationsQuery.hasNextPage || notificationsQuery.isFetchingNextPage) return;
    void notificationsQuery.fetchNextPage();
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        ref={scrollRef}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        refreshControl={user ? (
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={handlePullRefresh}
            tintColor={theme.colors.faint}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.panelSoft}
          />
        ) : undefined}
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{
          paddingTop: topInset + 18,
          paddingHorizontal: horizontalPadding,
          // Every row here is a tap target, so the list clears the raised
          // Create button rather than ending under it — the overlap variant
          // only accounts for the bar, and the button sits proud of it.
          paddingBottom: tabBarMetrics.contentBottomPadding,
          gap: 18,
        }}
      >
        <NotificationHeader
          signedIn={Boolean(user)}
          unreadCount={unreadCount}
          totalCount={notifications.length}
          hasOlder={notificationsQuery.hasNextPage}
          isRefreshing={notificationsQuery.isRefetching}
          onRefresh={() => {
            haptic.light();
            void refreshNewestAlerts();
          }}
          onMarkAllRead={() => markAllReadMutation.mutate()}
          canMarkAllRead={unreadCount > 0 && !markAllReadMutation.isPending}
        />

        {!user ? (
          <>
            <StatusBlock
              title="Sign in required"
              body="Sign in to review generation results, unlocks, follows, saves, remixes, and creator activity."
            />
            <PrimaryButton
              label="Sign in"
              onPress={() => router.push({ pathname: '/auth', params: { returnTo: ALERTS_ROUTE } } as never)}
              accent="primary"
            />
            <NotificationCategoryList />
          </>
        ) : (
          <>
            <PushControlCard
              result={devicePush.result}
              preferences={preferencesQuery.data?.preferences ?? null}
              isLoading={devicePush.isLoading}
              isPending={devicePush.isEnabling}
              preferencesDisabled={preferencesQuery.isLoading || updatePreferenceMutation.isPending}
              onEnable={devicePush.enable}
              onTogglePush={(value) => updatePreferenceMutation.mutate({ pushEnabled: value })}
            />
            {devicePush.checkFailed ? (
              <View style={{ gap: appTheme.spacing.gap }}>
                <StatusBlock tone="danger" title="Could not check push alerts" body="In-app history still works. Check your connection, then retry push setup." />
                <SecondaryButton label="Retry push setup" onPress={devicePush.recheck} />
              </View>
            ) : null}
            {actionError ? (
              <StatusBlock
                tone="danger"
                title="That alert change did not save"
                body={actionError instanceof Error ? actionError.message : 'Try again.'}
              />
            ) : null}
            {notificationsQuery.isLoading ? (
              <LoadingState />
            ) : notificationsQuery.isLoadingError ? (
              <View style={{ gap: appTheme.spacing.gap }}>
                <StatusBlock tone="danger" title="Could not load alerts" body="Check your connection, then try again." />
                <SecondaryButton label="Retry notifications" onPress={() => void notificationsQuery.refetch()} />
              </View>
            ) : (
              <>
                {/* A list already drawn stays drawn when a later read fails. */}
                {notificationsQuery.isRefetchError ? (
                  <StatusBlock tone="danger" title="Could not refresh alerts" body="Check your connection, then pull down to try again." />
                ) : null}
                {notifications.length > 0 ? (
                  <>
                    <NotificationList
                      notifications={notifications}
                      onPressNotification={handlePressNotification}
                    />
                    {notificationsQuery.hasNextPage ? (
                      <OlderAlertsFooter
                        loading={notificationsQuery.isFetchingNextPage}
                        failed={notificationsQuery.isFetchNextPageError}
                        onPress={loadOlderAlerts}
                      />
                    ) : null}
                  </>
                ) : (
                  <CaughtUpState />
                )}
              </>
            )}
            {preferencesQuery.isError ? (
              <View style={{ gap: appTheme.spacing.gap }}>
                <StatusBlock tone="danger" title="Could not load alert preferences" body="Your current preferences have not been changed." />
                <SecondaryButton label="Retry preferences" onPress={() => void preferencesQuery.refetch()} />
              </View>
            ) : (
              <NotificationPreferences
                preferences={preferencesQuery.data?.preferences ?? null}
                disabled={preferencesQuery.isLoading || updatePreferenceMutation.isPending}
                onToggle={(key, value) => updatePreferenceMutation.mutate({ [key]: value })}
              />
            )}
          </>
        )}
      </ScrollView>

      <TopScrim topInset={topInset} />
    </View>
  );
}

function NotificationHeader({
  signedIn,
  unreadCount,
  totalCount,
  hasOlder,
  isRefreshing,
  onRefresh,
  onMarkAllRead,
  canMarkAllRead,
}: {
  signedIn: boolean;
  unreadCount: number;
  totalCount: number;
  /** More alerts than the list holds: the count is a floor. */
  hasOlder: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
  onMarkAllRead: () => void;
  canMarkAllRead: boolean;
}) {
  const alertLabel = hasOlder ? `${totalCount}+ alerts` : totalCount === 1 ? '1 alert' : `${totalCount} alerts`;
  const deliveryLabel = isRefreshing ? 'Syncing' : 'Mobile';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
        <AppText
          numberOfLines={1}
          variant="pageTitle"
          accessibilityRole="header"
        >
          Alerts
        </AppText>
        <AppText variant="bodySm" color="muted" style={{ fontWeight: '700' }}>
          {signedIn
            // Middle dots, matching the metadata separator used on feed rows
            // and post details. A pipe reads as a table rule rather than as
            // punctuation between related facts.
            ? `${unreadCount} unread · ${alertLabel} · ${deliveryLabel}`
            : 'Sign in to view alerts'}
        </AppText>
      </View>
      {signedIn ? (
        <View style={{ flexDirection: 'row', gap: 9 }}>
          <IconButton icon={RefreshCw} label="Refresh alerts" disabled={isRefreshing} onPress={onRefresh} accent="motion" />
          {unreadCount > 0 ? (
            <IconButton icon={CheckCheck} label="Mark all alerts read" disabled={!canMarkAllRead} onPress={onMarkAllRead} accent="workflow" />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function LoadingState() {
  const theme = useAppTheme();
  return (
    <Card variant="soft" style={{ minHeight: 144, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={theme.colors.primary} />
      <AppText variant="bodySm" color="muted" style={{ fontWeight: '700' }}>Loading alerts</AppText>
    </Card>
  );
}

function CaughtUpState() {
  const theme = useAppTheme();
  return (
    <Card accent="workflow" variant="soft" style={{ minHeight: 156, justifyContent: 'center' }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: hexWithAlpha(theme.colors.success, 0.13), borderWidth: 1, borderColor: hexWithAlpha(theme.colors.success, 0.28) }}>
        <CheckCircle2 size={appTheme.icon.feature} color={theme.colors.success} />
      </View>
      <View style={{ gap: 6 }}>
        <AppText variant="cardTitle">You are all caught up.</AppText>
        <AppText variant="bodySm" color="muted">
          New alerts will appear here with direct links back to the right screen.
        </AppText>
      </View>
    </Card>
  );
}

function NotificationList({
  notifications,
  onPressNotification,
}: {
  notifications: MobileNotification[];
  onPressNotification: (notification: MobileNotification) => void;
}) {
  return (
    <View style={{ gap: 10 }}>
      {notifications.map((notification) => (
        <NotificationRow
          key={notification.id}
          notification={notification}
          onPress={() => onPressNotification(notification)}
        />
      ))}
    </View>
  );
}

/**
 * The way to alerts past the newest page. A button rather than a read on
 * reaching the end: the alert-type switches sit below the list, and a page
 * read on the way down to them would push them away each time.
 */
function OlderAlertsFooter({
  loading,
  failed,
  onPress,
}: {
  loading: boolean;
  failed: boolean;
  onPress: () => void;
}) {
  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      {failed ? (
        <StatusBlock tone="danger" title="Could not load older alerts" body="Check your connection, then try again." />
      ) : null}
      <SecondaryButton
        label={loading ? 'Loading older alerts…' : 'Load older alerts'}
        disabled={loading}
        onPress={onPress}
      />
    </View>
  );
}

function NotificationPreferences({
  preferences,
  disabled,
  onToggle,
}: {
  preferences: PreferenceState | null;
  disabled: boolean;
  onToggle: (key: keyof PreferenceState, value: boolean) => void;
}) {
  const theme = useAppTheme();
  const rows: Array<{ key: keyof PreferenceState; title: string; body: string }> = [
    { key: 'generationEnabled', title: 'Generation', body: 'Finished and failed renders.' },
    { key: 'commerceEnabled', title: 'Recipes & credits', body: 'Purchases, restores, and resource access.' },
    { key: 'socialEnabled', title: 'Creator activity', body: 'Follows, saves, remixes, and shares.' },
  ];

  return (
    <Card accent="workflow" variant="soft" padding="sm" style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <AppText variant="body" style={{ fontWeight: '700' }}>Alert types</AppText>
        <AppText variant="caption" color="muted">Choose which updates can become push alerts.</AppText>
      </View>
      <View
        style={{
          borderRadius: appTheme.radii.lg,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.colors.borderSubtle,
          backgroundColor: theme.colors.surfaceInset,
          overflow: 'hidden',
        }}
      >
        {rows.map((row, index) => {
          const enabled = Boolean(preferences?.[row.key]);
          const Icon = enabled ? ToggleRight : ToggleLeft;

          return (
            <Pressable
              key={row.key}
              accessibilityRole="switch"
              accessibilityLabel={row.title}
              accessibilityState={{ checked: enabled, disabled }}
              disabled={disabled || !preferences}
              onPress={() => onToggle(row.key, !enabled)}
              style={({ pressed }) => ({
                minHeight: 58,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: theme.colors.borderSubtle,
                opacity: disabled ? 0.62 : pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <AppText variant="body" style={{ fontWeight: '700' }}>{row.title}</AppText>
                <AppText variant="caption" color="muted">{row.body}</AppText>
              </View>
              <Icon size={appTheme.icon.hero} color={enabled ? theme.colors.success : theme.colors.faint} />
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

function PushControlCard({
  result,
  preferences,
  isLoading,
  isPending,
  preferencesDisabled,
  onEnable,
  onTogglePush,
}: {
  result: MobilePushRegistrationResult | null;
  preferences: PreferenceState | null;
  isLoading: boolean;
  isPending: boolean;
  preferencesDisabled: boolean;
  onEnable: () => void;
  onTogglePush: (value: boolean) => void;
}) {
  const theme = useAppTheme();
  const preferencesReady = Boolean(preferences);
  const pushEnabled = preferences?.pushEnabled ?? false;
  let title = 'Push alerts';
  let body = 'Syncing your push preference.';
  let actionLabel = 'Enable';
  let action: (() => void) | undefined;
  let actionAccent: 'primary' | 'image' = 'primary';
  let showToggle = result?.status === 'registered' || result?.status === 'not-mobile';

  if (preferencesReady) {
    title = pushEnabled ? 'Push alerts' : 'Push alerts paused';
    // One setting for the account, not this phone: the server keeps a single
    // preference per account and sends to every phone signed in to it, so a
    // pause here pauses them all. The card said "this device".
    body = pushEnabled
      ? 'Push notifications for your account on every device.'
      : 'Paused for your account on every device. Alerts still appear here.';
  }

  if (isLoading) {
    title = 'Checking push alerts';
    body = 'Syncing notification access for this device.';
    actionLabel = 'Checking';
    showToggle = false;
  } else if (result?.status === 'permission-required' || result === null) {
    title = 'Enable push alerts';
    body = 'Get finished renders, creator activity, and unlock updates as notifications on this device.';
    action = onEnable;
    showToggle = false;
  } else if (result?.status === 'denied') {
    title = 'Push alerts are off';
    body = 'Notifications are disabled for this device. Re-enable them in system settings.';
    actionLabel = 'Settings';
    action = () => {
      void Linking.openSettings();
    };
    actionAccent = 'image';
    showToggle = false;
  } else if (result?.status === 'missing-firebase-setup') {
      title = 'Push delivery is unavailable in this build';
      body = 'Your in-app history still works. Push alerts will become available after the app is updated.';
      actionAccent = 'image';
      showToggle = false;
  } else if (result?.status === 'missing-project-id') {
      title = 'Push delivery is unavailable in this build';
      body = 'Your in-app history still works. Push alerts will become available after the app is updated.';
      actionAccent = 'image';
      showToggle = false;
  }

  const iconColor = actionAccent === 'image' ? theme.colors.image : theme.colors.primary;
  // What this phone allows is its own system permission, apart from the
  // account's switch beside it.
  const permissionLine = showToggle && result?.status === 'registered' ? 'This device allows notifications.' : null;

  return (
    <Card
      accent={actionAccent}
      variant="soft"
      padding="sm"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: `${iconColor}1f`, borderWidth: 1, borderColor: `${iconColor}55` }}>
        <BellRing size={appTheme.icon.default} color={iconColor} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <AppText variant="body" style={{ fontWeight: '700' }}>{title}</AppText>
        <AppText variant="caption" color="muted">{body}</AppText>
        {permissionLine ? <AppText variant="caption" color="faint">{permissionLine}</AppText> : null}
      </View>
      {showToggle ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Push alerts for your account"
          accessibilityHint="Turns push alerts on or off on every device signed in to this account."
          accessibilityState={{ checked: pushEnabled, disabled: preferencesDisabled || !preferences }}
          disabled={preferencesDisabled || !preferences}
          onPress={() => onTogglePush(!pushEnabled)}
          style={({ pressed }) => ({
            minWidth: appTheme.touch.compact,
            minHeight: appTheme.touch.compact,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: preferencesDisabled || !preferences ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          {pushEnabled ? (
            <ToggleRight size={appTheme.icon.hero} color={theme.colors.success} />
          ) : (
            <ToggleLeft size={appTheme.icon.hero} color={theme.colors.faint} />
          )}
        </Pressable>
      ) : action || isPending ? (
        <CompactActionButton
          label={actionLabel}
          onPress={action}
          loading={isPending}
          accent={actionAccent}
        />
      ) : null}
    </Card>
  );
}

function CompactActionButton({
  label,
  onPress,
  loading,
  accent,
}: {
  label: string;
  onPress?: () => void;
  loading?: boolean;
  accent: 'primary' | 'image';
}) {
  const theme = useAppTheme();
  const color = accent === 'image' ? theme.colors.image : theme.colors.primary;
  const isPrimary = accent === 'primary';
  // A coral fill is the bright coral in both schemes, with ink on it; `primary`
  // goes deep on light and is for coral text and washes.
  const fill = theme.colors.primaryFill;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={!onPress || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appTheme.touch.compact,
        minWidth: 88,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        backgroundColor: isPrimary ? fill : `${color}24`,
        borderWidth: 1,
        borderColor: `${isPrimary ? fill : color}66`,
        opacity: !onPress ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 12,
      })}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary ? theme.colors.onPrimary : color} />
      ) : (
        <AppText selectable={false} variant="caption" color={isPrimary ? 'onPrimary' : color} style={{ fontWeight: '800' }} numberOfLines={1}>
          {label}
        </AppText>
      )}
    </Pressable>
  );
}

function NotificationRow({ notification, onPress }: { notification: MobileNotification; onPress: () => void }) {
  const theme = useAppTheme();
  const meta = CATEGORY_META[notification.category] ?? CATEGORY_META.system;
  const toneColor = theme.colors[meta.tone];
  const Icon = meta.Icon;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${notification.isRead ? '' : 'Unread. '}${notification.title}. ${notification.body}. ${formatRelativeTime(notification.updatedAt)}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        borderRadius: 22,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: notification.isRead ? theme.colors.borderSubtle : `${toneColor}66`,
        backgroundColor: notification.isRead ? theme.colors.surface : theme.colors.selected,
        padding: 14,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: `${toneColor}1c`, borderWidth: 1, borderColor: `${toneColor}4a` }}>
        <Icon size={appTheme.icon.default} color={toneColor} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <AppText variant="body" style={{ flex: 1, fontWeight: '700' }} numberOfLines={2}>
            {notification.title}
          </AppText>
          {!notification.isRead ? <UnreadDot color={toneColor} /> : null}
        </View>
        <AppText variant="bodySm" color="muted" numberOfLines={3}>
          {notification.body}
        </AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge label={meta.label} color={toneColor} />
          {notification.eventCount > 1 ? <Badge label={`${notification.eventCount} updates`} color={theme.colors.primary} /> : null}
          <AppText variant="caption" color="faint" style={{ fontWeight: '800' }}>
            {formatRelativeTime(notification.updatedAt)}
          </AppText>
        </View>
      </View>
    </Pressable>
  );
}

function UnreadDot({ color }: { color: string }) {
  return (
    <View
      style={{
        width: 9,
        height: 9,
        borderRadius: 5,
        backgroundColor: color,
      }}
    />
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View
      style={{
        minHeight: 24,
        borderRadius: 12,
        paddingHorizontal: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: `${color}1f`,
        borderWidth: 1,
        borderColor: `${color}55`,
      }}
    >
      <AppText variant="caption" color={color} style={{ fontWeight: '800' }}>{label}</AppText>
    </View>
  );
}

function NotificationCategoryList() {
  const theme = useAppTheme();
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <AppText variant="cardTitle">What shows here</AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Clock3 size={appTheme.icon.xs} color={theme.colors.faint} />
          <AppText variant="caption" color="faint" style={{ fontWeight: '800' }}>History</AppText>
        </View>
      </View>
      {NOTIFICATION_CATEGORIES.map((item) => {
        const Icon = item.icon;

        return (
          <Card
            key={item.title}
            variant="soft"
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: `${theme.colors[item.tone]}1c`, borderWidth: 1, borderColor: `${theme.colors[item.tone]}4a` }}>
              <Icon size={appTheme.icon.default} color={theme.colors[item.tone]} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
              <AppText variant="body" style={{ fontWeight: '800' }}>{item.title}</AppText>
              <AppText variant="bodySm" color="muted">{item.body}</AppText>
            </View>
          </Card>
        );
      })}
    </View>
  );
}

