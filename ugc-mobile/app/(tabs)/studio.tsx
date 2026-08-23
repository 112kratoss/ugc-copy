import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useScrollToTop } from '@react-navigation/native';
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
import { useRef } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TopScrim } from '@/components/top-scrim';
import { AppText, Card, IconButton, PrimaryButton, SecondaryButton, StatusBlock } from '@/components/ui';
import { haptic } from '@/lib/haptics';
import { useAuth } from '@/lib/auth';
import { navigateToNotificationDeepLink, registerForMobilePushNotifications, type MobilePushRegistrationResult } from '@/lib/notifications';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme } from '@/lib/theme';
import type { MobileNotification, MobileNotificationCategory, MobileNotificationPreferences as PreferenceState } from '@/lib/types';

const NOTIFICATION_CATEGORIES = [
  {
    title: 'Generation updates',
    body: 'Finished renders, failed runs, and long-running jobs land here first.',
    icon: WandSparkles,
    color: '#a78bfa',
  },
  {
    title: 'Creator activity',
    body: 'New followers, saves, remixes, and authenticated shares are grouped into a quieter history.',
    icon: Heart,
    color: '#fb7185',
  },
  {
    title: 'Unlocks & credits',
    body: 'Credit purchases, restores, and resource unlocks stay visible after the push fades.',
    icon: CreditCard,
    color: '#fbbf24',
  },
] as const;

const CATEGORY_META: Record<MobileNotificationCategory, { color: string; label: string; Icon: typeof BellRing }> = {
  generation: { color: '#a78bfa', label: 'Generation', Icon: WandSparkles },
  commerce: { color: '#fbbf24', label: 'Unlocks', Icon: CreditCard },
  social: { color: '#fb7185', label: 'Creator', Icon: Heart },
  system: { color: '#67e8f9', label: 'System', Icon: BellRing },
};

export default function StudioScreen() {
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
  const queryKey = ['mobile-notifications', user?.id] as const;
  const preferencesQueryKey = ['mobile-notification-preferences', user?.id] as const;
  const devicePushQueryKey = ['mobile-push-registration', user?.id] as const;

  const notificationsQuery = useQuery({
    queryKey,
    enabled: Boolean(user),
    queryFn: () => api.listMobileNotifications({ limit: 50 }),
    staleTime: 1000 * 20,
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

  const devicePushQuery = useQuery({
    queryKey: devicePushQueryKey,
    enabled: Boolean(user),
    queryFn: () => registerForMobilePushNotifications(api, { requestPermission: false }),
    staleTime: 1000 * 30,
  });

  const enablePushMutation = useMutation({
    mutationFn: () => registerForMobilePushNotifications(api, { requestPermission: true }),
    onSuccess: (result) => {
      queryClient.setQueryData(devicePushQueryKey, result);
    },
  });

  const notifications = notificationsQuery.data?.notifications ?? [];
  const unreadCount = notificationsQuery.data?.unreadCount
    ?? notifications.filter((notification) => !notification.isRead).length;
  const actionError = markReadMutation.error
    ?? markAllReadMutation.error
    ?? updatePreferenceMutation.error
    ?? enablePushMutation.error;

  const handlePressNotification = (notification: MobileNotification) => {
    if (!notification.isRead) {
      markReadMutation.mutate(notification.id);
    }

    if (!navigateToNotificationDeepLink(notification.deepLink)) {
      router.push('/studio' as never);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <ScrollView
        ref={scrollRef}
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: appTheme.colors.background }}
        contentContainerStyle={{
          paddingTop: topInset + 18,
          paddingHorizontal: horizontalPadding,
          paddingBottom: tabBarMetrics.contentBottomOverlapPadding,
          gap: 18,
        }}
      >
        <NotificationHeader
          signedIn={Boolean(user)}
          unreadCount={unreadCount}
          totalCount={notifications.length}
          isRefreshing={notificationsQuery.isRefetching}
          onRefresh={() => {
            haptic.light();
            void notificationsQuery.refetch();
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
            <PrimaryButton label="Sign in" onPress={() => router.push('/auth')} accent="primary" />
            <NotificationCategoryList />
          </>
        ) : (
          <>
            <PushControlCard
              result={enablePushMutation.data ?? devicePushQuery.data ?? null}
              preferences={preferencesQuery.data?.preferences ?? null}
              isLoading={devicePushQuery.isLoading}
              isPending={enablePushMutation.isPending}
              preferencesDisabled={preferencesQuery.isLoading || updatePreferenceMutation.isPending}
              onEnable={() => enablePushMutation.mutate()}
              onTogglePush={(value) => updatePreferenceMutation.mutate({ pushEnabled: value })}
            />
            {devicePushQuery.isError ? (
              <View style={{ gap: appTheme.spacing.gap }}>
                <StatusBlock tone="danger" title="Could not check push alerts" body="In-app history still works. Check your connection, then retry push setup." />
                <SecondaryButton label="Retry push setup" onPress={() => void devicePushQuery.refetch()} />
              </View>
            ) : null}
            {actionError ? (
              <StatusBlock
                tone="danger"
                title="That notification change did not save"
                body={actionError instanceof Error ? actionError.message : 'Try again.'}
              />
            ) : null}
            {notificationsQuery.isLoading ? (
              <LoadingState />
            ) : notificationsQuery.isError ? (
              <View style={{ gap: appTheme.spacing.gap }}>
                <StatusBlock tone="danger" title="Could not load notifications" body="Check your connection, then try again." />
                <SecondaryButton label="Retry notifications" onPress={() => void notificationsQuery.refetch()} />
              </View>
            ) : notifications.length > 0 ? (
              <NotificationList
                notifications={notifications}
                onPressNotification={handlePressNotification}
              />
            ) : (
              <CaughtUpState />
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
  isRefreshing,
  onRefresh,
  onMarkAllRead,
  canMarkAllRead,
}: {
  signedIn: boolean;
  unreadCount: number;
  totalCount: number;
  isRefreshing: boolean;
  onRefresh: () => void;
  onMarkAllRead: () => void;
  canMarkAllRead: boolean;
}) {
  const alertLabel = totalCount === 1 ? '1 alert' : `${totalCount} alerts`;
  const deliveryLabel = isRefreshing ? 'Syncing' : 'Mobile';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
        <AppText
          numberOfLines={1}
          variant="pageTitle"
          accessibilityRole="header"
        >
          Notifications
        </AppText>
        <AppText variant="bodySm" color="muted" style={{ fontWeight: '700' }}>
          {signedIn
            ? `${unreadCount} unread | ${alertLabel} | ${deliveryLabel}`
            : 'Sign in to view alerts'}
        </AppText>
      </View>
      {signedIn ? (
        <View style={{ flexDirection: 'row', gap: 9 }}>
          <IconButton icon={RefreshCw} label="Refresh notifications" disabled={isRefreshing} onPress={onRefresh} accent="motion" />
          {unreadCount > 0 ? (
            <IconButton icon={CheckCheck} label="Mark all notifications read" disabled={!canMarkAllRead} onPress={onMarkAllRead} accent="workflow" />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function LoadingState() {
  return (
    <Card variant="soft" style={{ minHeight: 144, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={appTheme.colors.primary} />
      <AppText variant="bodySm" color="muted" style={{ fontWeight: '700' }}>Loading alerts</AppText>
    </Card>
  );
}

function CaughtUpState() {
  return (
    <Card accent="workflow" variant="soft" style={{ minHeight: 156, justifyContent: 'center' }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(52,211,153,0.13)', borderWidth: 1, borderColor: 'rgba(52,211,153,0.28)' }}>
        <CheckCircle2 size={24} color="#6ee7b7" strokeWidth={2.4} />
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

function NotificationPreferences({
  preferences,
  disabled,
  onToggle,
}: {
  preferences: PreferenceState | null;
  disabled: boolean;
  onToggle: (key: keyof PreferenceState, value: boolean) => void;
}) {
  const rows: Array<{ key: keyof PreferenceState; title: string; body: string }> = [
    { key: 'generationEnabled', title: 'Generation', body: 'Finished and failed renders.' },
    { key: 'commerceEnabled', title: 'Credits & unlocks', body: 'Purchases, restores, and resource access.' },
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
          borderColor: appTheme.colors.borderSubtle,
          backgroundColor: appTheme.colors.surfaceInset,
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
                borderTopColor: 'rgba(255,255,255,0.08)',
                opacity: disabled ? 0.62 : pressed ? 0.78 : 1,
              })}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <AppText variant="body" style={{ fontWeight: '700' }}>{row.title}</AppText>
                <AppText variant="caption" color="muted">{row.body}</AppText>
              </View>
              <Icon size={32} color={enabled ? '#6ee7b7' : appTheme.colors.faint} strokeWidth={2.2} />
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
    body = pushEnabled
      ? 'Native delivery is on for this device.'
      : 'History still appears here. Turn push back on when you want native delivery.';
  }

  if (isLoading) {
    title = 'Checking push alerts';
    body = 'Syncing notification access for this device.';
    actionLabel = 'Checking';
    showToggle = false;
  } else if (result?.status === 'permission-required' || result === null) {
    title = 'Enable push alerts';
    body = 'Get finished renders, creator activity, and unlock updates as native alerts.';
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

  const iconColor = actionAccent === 'image' ? appTheme.colors.image : appTheme.colors.primary;

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
        <BellRing size={20} color={iconColor} strokeWidth={2.4} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <AppText variant="body" style={{ fontWeight: '700' }}>{title}</AppText>
        <AppText variant="caption" color="muted">{body}</AppText>
      </View>
      {showToggle ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Push alerts"
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
            <ToggleRight size={34} color="#6ee7b7" strokeWidth={2.2} />
          ) : (
            <ToggleLeft size={34} color={appTheme.colors.faint} strokeWidth={2.2} />
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
  const color = accent === 'image' ? appTheme.colors.image : appTheme.colors.primary;
  const isPrimary = accent === 'primary';

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
        backgroundColor: isPrimary ? color : `${color}24`,
        borderWidth: 1,
        borderColor: `${color}66`,
        opacity: !onPress ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 12,
      })}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary ? appTheme.colors.onPrimary : color} />
      ) : (
        <AppText selectable={false} variant="caption" color={isPrimary ? 'onPrimary' : color} style={{ fontWeight: '800' }} numberOfLines={1}>
          {label}
        </AppText>
      )}
    </Pressable>
  );
}

function NotificationRow({ notification, onPress }: { notification: MobileNotification; onPress: () => void }) {
  const meta = CATEGORY_META[notification.category] ?? CATEGORY_META.system;
  const Icon = meta.Icon;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${notification.isRead ? '' : 'Unread. '}${notification.title}. ${notification.body}. ${formatNotificationTime(notification.updatedAt)}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        borderRadius: 22,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: notification.isRead ? appTheme.colors.borderSubtle : `${meta.color}66`,
        backgroundColor: notification.isRead ? appTheme.colors.surface : appTheme.colors.selected,
        padding: 14,
        opacity: pressed ? 0.78 : 1,
      })}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: `${meta.color}1c`, borderWidth: 1, borderColor: `${meta.color}4a` }}>
        <Icon size={21} color={meta.color} strokeWidth={2.4} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <AppText variant="body" style={{ flex: 1, fontWeight: '700' }} numberOfLines={2}>
            {notification.title}
          </AppText>
          {!notification.isRead ? <UnreadDot color={meta.color} /> : null}
        </View>
        <AppText variant="bodySm" color="muted" numberOfLines={3}>
          {notification.body}
        </AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge label={meta.label} color={meta.color} />
          {notification.eventCount > 1 ? <Badge label={`${notification.eventCount} updates`} color={appTheme.colors.primary} /> : null}
          <AppText variant="caption" color="faint" style={{ fontWeight: '800' }}>
            {formatNotificationTime(notification.updatedAt)}
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
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <AppText variant="cardTitle">What shows here</AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Clock3 size={14} color={appTheme.colors.faint} strokeWidth={2.3} />
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
            <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: `${item.color}1c`, borderWidth: 1, borderColor: `${item.color}4a` }}>
              <Icon size={21} color={item.color} strokeWidth={2.4} />
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

function formatNotificationTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return 'Just now';
  }

  const diffMs = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'Just now';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}
