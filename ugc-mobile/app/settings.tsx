import { router } from 'expo-router';
import { ArrowUpRight, Bell, ChevronRight, CircleHelp, CreditCard, FileText, Gift, ShieldCheck, Trash2, UserRound } from 'lucide-react-native';
import { Linking, Pressable, View } from 'react-native';

import { AppText, Card, Screen, SectionTitle } from '@/components/ui';
import { OnboardingResumeCard } from '@/components/onboarding-resume-card';
import { formatCreditAmount } from '@/lib/pricing';
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

      <GroupLabel>Account</GroupLabel>

      <SettingsCard
        icon={<UserRound size={appTheme.icon.feature} color={appTheme.colors.primary} />}
        title="Profile"
        body={user?.email ?? 'Sign in to connect your creator profile.'}
        onPress={() => router.push(user ? '/profile' as never : '/auth' as never)}
      />

      <SettingsCard
        icon={<CreditCard size={appTheme.icon.feature} color={appTheme.colors.amber} />}
        title="Credits"
        body={`${formatCreditAmount(credits)} credits available on this account.`}
        onPress={() => router.push('/pricing' as never)}
      />

      <SettingsCard
        icon={<Gift size={appTheme.icon.feature} color={appTheme.colors.commerce} />}
        title="Invite & Earn"
        body={user ? 'Share your referral link and track bonus credits.' : 'Apply an invite code or sign in to share your link.'}
        onPress={() => router.push('/invite' as never)}
      />

      <SettingsCard
        icon={<Bell size={appTheme.icon.feature} color={appTheme.colors.info} />}
        title="Alerts"
        body="Review your alerts history and creator updates."
        onPress={() => router.push('/studio' as never)}
      />

      <GroupLabel>Support & legal</GroupLabel>

      <SettingsCard
        icon={<CircleHelp size={appTheme.icon.feature} color={appTheme.colors.text} />}
        title="Help & support"
        body="Find quick guidance for creations, unlocks, and contacting support."
        onPress={() => router.push('/help' as never)}
      />

      <SettingsCard
        icon={<ShieldCheck size={appTheme.icon.feature} color={appTheme.colors.info} />}
        title="Privacy policy"
        body="Review how Magicbooklet collects, uses, stores, and deletes data."
        external
        onPress={() => void Linking.openURL(`${env.siteUrl}/privacy`)}
      />

      <SettingsCard
        icon={<FileText size={appTheme.icon.feature} color={appTheme.colors.muted} />}
        title="Terms of service"
        body="Review the terms that apply to accounts, credits, and creations."
        external
        onPress={() => void Linking.openURL(`${env.siteUrl}/terms`)}
      />

      <SettingsCard
        icon={<ShieldCheck size={appTheme.icon.feature} color={appTheme.colors.warning} />}
        title="Child safety standards"
        body="Review our zero-tolerance policy and report child-safety concerns."
        external
        onPress={() => void Linking.openURL(`${env.siteUrl}/child-safety`)}
      />

      {user ? (
        <SettingsCard
          icon={<Trash2 size={appTheme.icon.feature} color={appTheme.colors.danger} />}
          title="Delete account"
          body="Permanently delete your account and personal data."
          destructive
          onPress={() => router.push('/delete-account' as never)}
        />
      ) : (
        <SettingsCard
          icon={<Trash2 size={appTheme.icon.feature} color={appTheme.colors.danger} />}
          title="Account deletion"
          body="See how to request deletion of an existing Magicbooklet account."
          external
          onPress={() => void Linking.openURL(`${env.siteUrl}/delete-account`)}
        />
      )}
    </Screen>
  );
}

function GroupLabel({ children }: { children: string }) {
  return (
    <View style={{ marginTop: appTheme.spacing.compact }}>
      <AppText variant="label" color="muted">{children}</AppText>
    </View>
  );
}

function SettingsCard({
  icon,
  title,
  body,
  onPress,
  external,
  destructive,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onPress: () => void;
  /** Leaves the app: link semantics and a trailing arrow instead of the drill-down chevron. */
  external?: boolean;
  destructive?: boolean;
}) {
  const Trailing = external ? ArrowUpRight : ChevronRight;
  return (
    <Pressable
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={`${title}. ${body}`}
      accessibilityHint={external ? 'Opens in your browser.' : undefined}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Card style={{ minHeight: 92, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: appTheme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <AppText variant="cardTitle" color={destructive ? 'danger' : undefined}>{title}</AppText>
          <AppText variant="bodySm" color="muted">{body}</AppText>
        </View>
        <Trailing size={appTheme.icon.default} color={appTheme.colors.faint} />
      </Card>
    </Pressable>
  );
}
