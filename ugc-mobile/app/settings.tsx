import { router } from 'expo-router';
import { Bell, ChevronRight, CreditCard, UserRound } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { AppText, Card, Screen, SectionTitle } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { appTheme } from '@/lib/theme';

export default function SettingsScreen() {
  const { user, credits } = useAuth();

  return (
    <Screen>
      <SectionTitle
        eyebrow="Settings"
        title="Account settings."
        body={user ? 'Manage profile details, credits, and app preferences.' : 'Sign in to manage your Magicbooklet account.'}
      />

      <SettingsCard
        icon={<UserRound size={22} color={appTheme.colors.primary} />}
        title="Profile"
        body={user?.email ?? 'Sign in to connect your creator profile.'}
        onPress={() => router.push(user ? '/profile' as never : '/auth' as never)}
      />

      <SettingsCard
        icon={<CreditCard size={22} color="#fbbf24" />}
        title="Credits"
        body={`${credits ?? 0} credits available on this account.`}
        onPress={() => router.push('/pricing' as never)}
      />

      <SettingsCard
        icon={<Bell size={22} color="#22d3ee" />}
        title="Notifications"
        body="Review mobile notification history and creator updates."
        onPress={() => router.push('/studio' as never)}
      />
    </Screen>
  );
}

function SettingsCard({
  icon,
  title,
  body,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}`}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Card style={{ minHeight: 92, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: appTheme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <AppText variant="cardTitle">{title}</AppText>
          <AppText variant="bodySm" color="muted">{body}</AppText>
        </View>
        <ChevronRight size={20} color={appTheme.colors.faint} />
      </Card>
    </Pressable>
  );
}
