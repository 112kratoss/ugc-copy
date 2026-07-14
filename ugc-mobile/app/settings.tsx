import { router } from 'expo-router';
import { Bell, ChevronRight, CreditCard, FileText, Gift, ShieldCheck, Trash2, UserRound } from 'lucide-react-native';
import { Linking, Pressable, View } from 'react-native';

import { AppText, Card, Screen, SectionTitle } from '@/components/ui';
import { OnboardingResumeCard } from '@/components/onboarding-resume-card';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
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

      <OnboardingResumeCard compact />

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
        icon={<Gift size={22} color={appTheme.colors.commerce} />}
        title="Invite & Earn"
        body={user ? 'Share your referral link and track bonus credits.' : 'Apply an invite code or sign in to share your link.'}
        onPress={() => router.push('/invite' as never)}
      />

      <SettingsCard
        icon={<Bell size={22} color="#22d3ee" />}
        title="Notifications"
        body="Review mobile notification history and creator updates."
        onPress={() => router.push('/studio' as never)}
      />

      <SettingsCard
        icon={<ShieldCheck size={22} color="#22d3ee" />}
        title="Privacy policy"
        body="Review how Magic Booklet collects, uses, stores, and deletes data."
        onPress={() => void Linking.openURL(`${env.siteUrl}/privacy`)}
      />

      <SettingsCard
        icon={<FileText size={22} color={appTheme.colors.muted} />}
        title="Terms of service"
        body="Review the terms that apply to accounts, credits, and creations."
        onPress={() => void Linking.openURL(`${env.siteUrl}/terms`)}
      />

      {user ? (
        <SettingsCard
          icon={<Trash2 size={22} color={appTheme.colors.danger} />}
          title="Delete account"
          body="Permanently delete your account and personal data."
          onPress={() => router.push('/delete-account' as never)}
        />
      ) : (
        <SettingsCard
          icon={<Trash2 size={22} color={appTheme.colors.danger} />}
          title="Account deletion"
          body="See how to request deletion of an existing Magic Booklet account."
          onPress={() => void Linking.openURL(`${env.siteUrl}/delete-account`)}
        />
      )}
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
