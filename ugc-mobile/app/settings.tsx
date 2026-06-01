import { router } from 'expo-router';
import { Bell, CreditCard, UserRound } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { Card, Screen, SecondaryButton, SectionTitle } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { appTheme } from '@/lib/theme';

export default function SettingsScreen() {
  const { user, credits } = useAuth();

  return (
    <Screen>
      <SectionTitle
        eyebrow="Settings"
        title="Account settings."
        body={user ? 'Manage profile details, credits, and app preferences.' : 'Sign in to manage your Magic Booklet account.'}
      />

      <SettingsCard
        icon={<UserRound size={22} color="#d946ef" />}
        title="Profile"
        body={user?.email ?? 'Sign in to connect your creator profile.'}
        actionLabel={user ? 'Open profile' : 'Sign in'}
        onPress={() => router.push(user ? '/profile' as never : '/auth' as never)}
      />

      <SettingsCard
        icon={<CreditCard size={22} color="#fbbf24" />}
        title="Credits"
        body={`${credits ?? 0} credits available on this account.`}
        actionLabel="View credits"
        onPress={() => router.push('/pricing' as never)}
      />

      <SettingsCard
        icon={<Bell size={22} color="#22d3ee" />}
        title="Notifications"
        body="Review mobile notification history and creator updates."
        actionLabel="Open notifications"
        onPress={() => router.push('/studio' as never)}
      />
    </Screen>
  );
}

function SettingsCard({
  icon,
  title,
  body,
  actionLabel,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  actionLabel: string;
  onPress: () => void;
}) {
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.07)', alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: appTheme.colors.text, fontSize: 18, fontWeight: '900' }}>{title}</Text>
          <Text style={{ color: appTheme.colors.muted, lineHeight: 21 }}>{body}</Text>
        </View>
      </View>
      <SecondaryButton label={actionLabel} onPress={onPress} />
    </Card>
  );
}
