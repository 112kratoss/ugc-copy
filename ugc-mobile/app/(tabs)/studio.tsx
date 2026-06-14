import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
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
import { ActivityIndicator, Linking, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, Card, IconButton, MetricCard, PrimaryButton, StatusBlock, SurfaceSection } from '@/components/ui';
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

  const handlePressNotification = (notification: MobileNotification) => {
    if (!notification.isRead) {
      markReadMutation.mutate(notification.id);
    }

    if (!navigateToNotificationDeepLink(notification.deepLink)) {
      router.push('/studio' as never);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background, paddingTop: topInset }}>
      <ScrollView
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: appTheme.colors.background }}
        contentContainerStyle={{
          paddingTop: 18,
          paddingHorizontal: horizontalPadding,
          paddingBottom: tabBarMetrics.contentBottomOverlapPadding,
          gap: 18,
        }}
      >
        <NotificationHeader
          signedIn={Boolean(user)}
          unreadCount={unreadCount}
          isRefreshing={notificationsQuery.isRefetching}
          onRefresh={() => notificationsQuery.refetch()}
          onMarkAllRead={() => markAllReadMutation.mutate()}
          canMarkAllRead={unreadCount > 0 && !markAllReadMutation.isPending}
        />

        {!user ? (
          <>
            <StatusBlock
              title="Sign in required"
              body="Sign in to review generation results, unlocks, follows, saves, remixes, and creator activity."
            />
            <PrimaryButton label="Sign in" onPress={() => router.push('/auth')} accent="motion" />
            <NotificationCategoryList />
          </>
        ) : (
          <>
            <NotificationSummary
              unreadCount={unreadCount}
              totalCount={notifications.length}
              isRefreshing={notificationsQuery.isRefetching}
            />
            <PushPermissionCard
              result={enablePushMutation.data ?? devicePushQuery.data ?? null}
              isLoading={devicePushQuery.isLoading}
              isPending={enablePushMutation.isPending}
              onEnable={() => enablePushMutation.mutate()}
            />
            {notificationsQuery.isLoading ? (
              <LoadingState />
            ) : notificationsQuery.isError ? (
              <StatusBlock
                title="Could not load notifications"
                body="Pull refresh or try again in a moment."
              />
            ) : notifications.length > 0 ? (
              <NotificationList
                notifications={notifications}
                onPressNotification={handlePressNotification}
              />
            ) : (
              <CaughtUpState />
            )}
            <NotificationPreferences
              preferences={preferencesQuery.data?.preferences ?? null}
              disabled={preferencesQuery.isLoading || updatePreferenceMutation.isPending}
              onToggle={(key, value) => updatePreferenceMutation.mutate({ [key]: value })}
            />
            <NotificationCategoryList />
          </>
        )}
      </ScrollView>
    </View>
  );
}

function NotificationHeader({
  signedIn,
  unreadCount,
  isRefreshing,
  onRefresh,
  onMarkAllRead,
  canMarkAllRead,
}: {
  signedIn: boolean;
  unreadCount: number;
  isRefreshing: boolean;
  onRefresh: () => void;
  onMarkAllRead: () => void;
  canMarkAllRead: boolean;
}) {
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
          <AppText
            numberOfLines={1}
            variant="pageTitle"
            style={{ fontSize: 34, lineHeight: 38 }}
          >
            Notifications
          </AppText>
          <AppText variant="bodySm" color="muted" style={{ fontWeight: '700' }}>
            {signedIn ? `${unreadCount} unread ${unreadCount === 1 ? 'alert' : 'alerts'}` : 'Mobile notification history'}
          </AppText>
        </View>
        <View style={{ flexDirection: 'row', gap: 9 }}>
          <IconButton icon={RefreshCw} label="Refresh notifications" disabled={isRefreshing} onPress={onRefresh} accent="motion" />
          <IconButton icon={CheckCheck} label="Mark all notifications read" disabled={!canMarkAllRead} onPress={onMarkAllRead} accent="workflow" />
        </View>
      </View>

      <LinearGradient
        colors={['rgba(217,70,239,0.2)', 'rgba(124,58,237,0.13)', 'rgba(34,211,238,0.09)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          minHeight: 98,
          borderRadius: 24,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: 'rgba(168,85,247,0.28)',
          padding: 16,
          justifyContent: 'center',
        }}
      >
        <AppText variant="cardTitle">
          Your mobile notification history.
        </AppText>
        <AppText variant="bodySm" color="muted" style={{ marginTop: 5 }}>
          Results, unlocks, and creator activity stay here after each push alert fades.
        </AppText>
      </LinearGradient>
    </View>
  );
}

function NotificationSummary({
  unreadCount,
  totalCount,
  isRefreshing,
}: {
  unreadCount: number;
  totalCount: number;
  isRefreshing: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <MetricCard label="Unread" value={String(unreadCount)} accent="motion" compact />
      <MetricCard label="History" value={totalCount > 0 ? String(totalCount) : 'Empty'} accent="image" compact />
      <MetricCard label="Delivery" value={isRefreshing ? 'Syncing' : 'Mobile'} accent="workflow" compact />
    </View>
  );
}

function LoadingState() {
  return (
    <Card variant="soft" style={{ minHeight: 144, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="#c084fc" />
      <AppText variant="bodySm" color="muted" style={{ fontWeight: '700' }}>Loading notification history</AppText>
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
          New mobile notifications appear here with unread state, timestamps, and quick paths back into the right screen.
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
    { key: 'pushEnabled', title: 'Push alerts', body: 'Native mobile delivery for this device.' },
    { key: 'generationEnabled', title: 'Generation', body: 'Finished and failed renders.' },
    { key: 'commerceEnabled', title: 'Credits & unlocks', body: 'Purchases, restores, and resource access.' },
    { key: 'socialEnabled', title: 'Creator activity', body: 'Follows, saves, remixes, and shares.' },
  ];

  return (
    <SurfaceSection
      eyebrow="Preferences"
      title="Push preferences"
      body="Tune alerts without leaving the mobile inbox."
      accent="workflow"
    >
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
                minHeight: 64,
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
                <AppText variant="body" style={{ fontWeight: '900' }}>{row.title}</AppText>
                <AppText variant="caption" color="muted">{row.body}</AppText>
              </View>
              <Icon size={32} color={enabled ? '#6ee7b7' : appTheme.colors.faint} strokeWidth={2.2} />
            </Pressable>
          );
        })}
      </View>
    </SurfaceSection>
  );
}

function PushPermissionCard({
  result,
  isLoading,
  isPending,
  onEnable,
}: {
  result: MobilePushRegistrationResult | null;
  isLoading: boolean;
  isPending: boolean;
  onEnable: () => void;
}) {
  if (result?.status === 'registered' || result?.status === 'not-mobile') {
    return null;
  }

  let title = 'Enable push alerts';
  let body = 'Turn on native alerts for finished renders, creator activity, and unlock updates on this device.';
  let actionLabel = 'Enable push alerts';
  let action: (() => void) | undefined = onEnable;
  let actionAccent: 'motion' | 'image' = 'motion';

  if (isLoading) {
    title = 'Checking this device';
    body = 'Looking up notification access and syncing the current push state.';
    actionLabel = 'Checking';
    action = undefined;
  } else if (result?.status === 'denied') {
    title = 'Push alerts are off';
    body = 'Notifications are disabled for this device. Re-enable them in system settings to get native alerts again.';
    actionLabel = 'Open system settings';
    action = () => {
      void Linking.openSettings();
    };
    actionAccent = 'image';
  } else if (result?.status === 'missing-firebase-setup') {
    title = 'Android push setup is incomplete';
    body = 'This build can show inbox history, but native Android delivery still needs Firebase credentials.';
    actionLabel = 'Refresh status';
    action = onEnable;
    actionAccent = 'image';
  } else if (result?.status === 'missing-project-id') {
    title = 'Push project setup is incomplete';
    body = 'The app is missing its Expo project identifier, so this device cannot register for push yet.';
    actionLabel = 'Refresh status';
    action = onEnable;
    actionAccent = 'image';
  }

  return (
    <SurfaceSection
      eyebrow="Device alerts"
      title={title}
      body={body}
      accent={actionAccent}
    >
      <PrimaryButton
        label={actionLabel}
        onPress={action}
        disabled={!action}
        loading={isPending}
        accent={actionAccent}
      />
    </SurfaceSection>
  );
}

function NotificationRow({ notification, onPress }: { notification: MobileNotification; onPress: () => void }) {
  const meta = CATEGORY_META[notification.category] ?? CATEGORY_META.system;
  const Icon = meta.Icon;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={notification.title}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        borderRadius: 22,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: notification.isRead ? appTheme.colors.borderSubtle : `${meta.color}66`,
        backgroundColor: notification.isRead ? appTheme.colors.surface : 'rgba(124,58,237,0.13)',
        padding: 14,
        opacity: pressed ? 0.78 : 1,
      })}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: `${meta.color}1c`, borderWidth: 1, borderColor: `${meta.color}4a` }}>
        <Icon size={21} color={meta.color} strokeWidth={2.4} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <AppText variant="body" style={{ flex: 1, fontWeight: '900' }} numberOfLines={2}>
            {notification.title}
          </AppText>
          {!notification.isRead ? <UnreadDot color={meta.color} /> : null}
        </View>
        <AppText variant="bodySm" color="muted" numberOfLines={3}>
          {notification.body}
        </AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge label={meta.label} color={meta.color} />
          {notification.eventCount > 1 ? <Badge label={`${notification.eventCount} updates`} color="#c084fc" /> : null}
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
        shadowColor: color,
        shadowOpacity: 0.7,
        shadowRadius: 8,
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
      <AppText variant="caption" color={color} style={{ fontWeight: '900' }}>{label}</AppText>
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
              <AppText variant="body" style={{ fontWeight: '900' }}>{item.title}</AppText>
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
