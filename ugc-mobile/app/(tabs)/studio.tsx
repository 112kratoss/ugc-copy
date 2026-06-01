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
import { ActivityIndicator, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { navigateToNotificationDeepLink } from '@/lib/notifications';
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
    <View style={{ flex: 1, backgroundColor: '#03040d', paddingTop: topInset }}>
      <ScrollView
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: '#03040d' }}
        contentContainerStyle={{
          paddingTop: 18,
          paddingHorizontal: horizontalPadding,
          paddingBottom: tabBarMetrics.contentBottomPadding,
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
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.76}
            style={{ color: '#fff', fontSize: 34, lineHeight: 38, fontWeight: '900' }}
          >
            Notifications
          </Text>
          <Text style={{ color: appTheme.colors.muted, fontSize: 13, lineHeight: 18, fontWeight: '700' }}>
            {signedIn ? `${unreadCount} unread ${unreadCount === 1 ? 'alert' : 'alerts'}` : 'Mobile notification history'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 9 }}>
          <HeaderIconButton label="Refresh notifications" disabled={isRefreshing} onPress={onRefresh}>
            <RefreshCw size={19} color="#ffffff" strokeWidth={2.4} />
          </HeaderIconButton>
          <HeaderIconButton label="Mark all notifications read" disabled={!canMarkAllRead} onPress={onMarkAllRead}>
            <CheckCheck size={19} color="#ffffff" strokeWidth={2.4} />
          </HeaderIconButton>
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
        <Text style={{ color: '#fff', fontSize: 20, lineHeight: 25, fontWeight: '900' }}>
          Your mobile notification history.
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 13, lineHeight: 19, fontWeight: '600', marginTop: 5 }}>
          Results, unlocks, and creator activity stay here after each push alert fades.
        </Text>
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
      <SummaryPill label="Unread" value={String(unreadCount)} />
      <SummaryPill label="History" value={totalCount > 0 ? String(totalCount) : 'Empty'} />
      <SummaryPill label="Delivery" value={isRefreshing ? 'Syncing' : 'Mobile'} />
    </View>
  );
}

function SummaryPill({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{
        flex: 1,
        minHeight: 66,
        borderRadius: 20,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(255,255,255,0.045)',
        paddingHorizontal: 12,
        paddingVertical: 11,
        justifyContent: 'center',
        gap: 4,
      }}
    >
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>
        {value}
      </Text>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '800' }}>
        {label}
      </Text>
    </View>
  );
}

function LoadingState() {
  return (
    <View
      style={{
        minHeight: 144,
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(255,255,255,0.048)',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
      }}
    >
      <ActivityIndicator color="#c084fc" />
      <Text style={{ color: appTheme.colors.muted, fontSize: 13, fontWeight: '700' }}>Loading notification history</Text>
    </View>
  );
}

function CaughtUpState() {
  return (
    <View
      style={{
        minHeight: 156,
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(255,255,255,0.048)',
        padding: 18,
        justifyContent: 'center',
        gap: 14,
      }}
    >
      <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(52,211,153,0.13)', borderWidth: 1, borderColor: 'rgba(52,211,153,0.28)' }}>
        <CheckCircle2 size={24} color="#6ee7b7" strokeWidth={2.4} />
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ color: '#fff', fontSize: 19, lineHeight: 24, fontWeight: '900' }}>You are all caught up.</Text>
        <Text style={{ color: appTheme.colors.muted, fontSize: 14, lineHeight: 21, fontWeight: '600' }}>
          New mobile notifications appear here with unread state, timestamps, and quick paths back into the right screen.
        </Text>
      </View>
    </View>
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
    <View style={{ gap: 12 }}>
      <Text style={{ color: '#fff', fontSize: 20, lineHeight: 25, fontWeight: '900' }}>Push preferences</Text>
      <View
        style={{
          borderRadius: 22,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.1)',
          backgroundColor: '#10111a',
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
                <Text style={{ color: '#fff', fontSize: 15, lineHeight: 20, fontWeight: '900' }}>{row.title}</Text>
                <Text style={{ color: appTheme.colors.muted, fontSize: 12, lineHeight: 18, fontWeight: '600' }}>{row.body}</Text>
              </View>
              <Icon size={32} color={enabled ? '#6ee7b7' : appTheme.colors.faint} strokeWidth={2.2} />
            </Pressable>
          );
        })}
      </View>
    </View>
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
        borderColor: notification.isRead ? 'rgba(255,255,255,0.1)' : `${meta.color}66`,
        backgroundColor: notification.isRead ? '#10111a' : 'rgba(124,58,237,0.13)',
        padding: 14,
        opacity: pressed ? 0.78 : 1,
      })}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: `${meta.color}1c`, borderWidth: 1, borderColor: `${meta.color}4a` }}>
        <Icon size={21} color={meta.color} strokeWidth={2.4} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1, color: '#fff', fontSize: 16, lineHeight: 21, fontWeight: '900' }} numberOfLines={2}>
            {notification.title}
          </Text>
          {!notification.isRead ? <UnreadDot color={meta.color} /> : null}
        </View>
        <Text style={{ color: appTheme.colors.muted, fontSize: 13, lineHeight: 20, fontWeight: '600' }} numberOfLines={3}>
          {notification.body}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge label={meta.label} color={meta.color} />
          {notification.eventCount > 1 ? <Badge label={`${notification.eventCount} updates`} color="#c084fc" /> : null}
          <Text style={{ color: appTheme.colors.faint, fontSize: 11, lineHeight: 16, fontWeight: '800' }}>
            {formatNotificationTime(notification.updatedAt)}
          </Text>
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
      <Text style={{ color, fontSize: 11, lineHeight: 15, fontWeight: '900' }}>{label}</Text>
    </View>
  );
}

function NotificationCategoryList() {
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Text style={{ color: '#fff', fontSize: 20, lineHeight: 25, fontWeight: '900' }}>What shows here</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Clock3 size={14} color={appTheme.colors.faint} strokeWidth={2.3} />
          <Text style={{ color: appTheme.colors.faint, fontSize: 11, fontWeight: '800' }}>History</Text>
        </View>
      </View>
      {NOTIFICATION_CATEGORIES.map((item) => {
        const Icon = item.icon;

        return (
          <View
            key={item.title}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 12,
              borderRadius: 22,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.1)',
              backgroundColor: '#10111a',
              padding: 14,
            }}
          >
            <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: `${item.color}1c`, borderWidth: 1, borderColor: `${item.color}4a` }}>
              <Icon size={21} color={item.color} strokeWidth={2.4} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
              <Text style={{ color: '#fff', fontSize: 16, lineHeight: 21, fontWeight: '900' }}>{item.title}</Text>
              <Text style={{ color: appTheme.colors.muted, fontSize: 13, lineHeight: 20, fontWeight: '600' }}>{item.body}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function HeaderIconButton({
  label,
  disabled,
  onPress,
  children,
}: {
  label: string;
  disabled?: boolean;
  onPress?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        backgroundColor: 'rgba(255,255,255,0.065)',
        opacity: disabled ? 0.44 : pressed ? 0.74 : 1,
      })}
    >
      {children}
    </Pressable>
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
