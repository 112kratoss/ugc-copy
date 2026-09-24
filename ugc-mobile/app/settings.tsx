import { useSyncExternalStore } from 'react';
import { router } from 'expo-router';
import { ArrowUpRight, Bell, ChevronRight, CircleHelp, CreditCard, FileText, Gift, ShieldCheck, Trash2, UserRound } from 'lucide-react-native';
import { Linking, Pressable, View } from 'react-native';

import { AppText, Card, Screen, SectionTitle } from '@/components/ui';
import { OnboardingResumeCard } from '@/components/onboarding-resume-card';
import { formatAppVersionLabel, readAppVersionParts, readUpdateRuntime } from '@/lib/app-version-label';
import {
  APPEARANCE_PREFERENCES,
  isAppearanceChoiceAvailable,
  setAppearancePreference,
  useAppearancePreference,
  type AppearancePreference,
} from '@/lib/appearance';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { formatSupportDetails, readCreatorSession, subscribeCreatorSession } from '@/lib/creator-session-diagnostics';
import { showMessageDialog } from '@/lib/dialog';
import {
  formatMediaDiagnosticsReport,
  readMediaDiagnostics,
  summarizeMediaDiagnostics,
} from '@/lib/media-diagnostics';
import { haptic } from '@/lib/haptics';
import { formatCreditAmount } from '@/lib/pricing';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

export default function SettingsScreen() {
  const theme = useAppTheme();
  const { user, credits } = useAuth();
  const versionLabel = formatAppVersionLabel(readAppVersionParts());
  // For support: the OTA runtime and channel, and how the last draft this launch
  // opened came back. It sits above the version, which stays the last line.
  const creatorSession = useSyncExternalStore(subscribeCreatorSession, readCreatorSession, readCreatorSession);
  const supportDetails = formatSupportDetails({ ...readUpdateRuntime(), session: creatorSession });

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
        icon={<UserRound size={appTheme.icon.feature} color={theme.colors.primary} />}
        title="Profile"
        body={user?.email ?? 'Sign in to connect your creator profile.'}
        onPress={() => router.push(user ? '/profile' as never : '/auth' as never)}
      />

      <SettingsCard
        icon={<CreditCard size={appTheme.icon.feature} color={theme.colors.amber} />}
        title="Credits"
        body={`${formatCreditAmount(credits)} credits available on this account.`}
        onPress={() => router.push('/pricing' as never)}
      />

      <SettingsCard
        icon={<Gift size={appTheme.icon.feature} color={theme.colors.commerce} />}
        title="Invite & Earn"
        body={user ? 'Share your referral link and track bonus credits.' : 'Apply an invite code or sign in to share your link.'}
        onPress={() => router.push('/invite' as never)}
      />

      <SettingsCard
        icon={<Bell size={appTheme.icon.feature} color={theme.colors.info} />}
        title="Alerts"
        body="Review your alerts history and creator updates."
        onPress={() => router.push('/studio' as never)}
      />

      {isAppearanceChoiceAvailable() ? (
        <>
          <GroupLabel>Display</GroupLabel>
          <AppearanceSetting />
        </>
      ) : null}

      <GroupLabel>Support & legal</GroupLabel>

      <SettingsCard
        icon={<CircleHelp size={appTheme.icon.feature} color={theme.colors.text} />}
        title="Help & support"
        body="Find quick guidance for creations, unlocks, and contacting support."
        onPress={() => router.push('/help' as never)}
      />

      <SettingsCard
        icon={<ShieldCheck size={appTheme.icon.feature} color={theme.colors.info} />}
        title="Privacy policy"
        body="Review how Magicbooklet collects, uses, stores, and deletes data."
        external
        onPress={() => void Linking.openURL(`${env.siteUrl}/privacy`)}
      />

      <SettingsCard
        icon={<FileText size={appTheme.icon.feature} color={theme.colors.muted} />}
        title="Terms of service"
        body="Review the terms that apply to accounts, credits, and creations."
        external
        onPress={() => void Linking.openURL(`${env.siteUrl}/terms`)}
      />

      <SettingsCard
        icon={<ShieldCheck size={appTheme.icon.feature} color={theme.colors.warning} />}
        title="Child safety standards"
        body="Review our zero-tolerance policy and report child-safety concerns."
        external
        onPress={() => void Linking.openURL(`${env.siteUrl}/child-safety`)}
      />

      {user ? (
        <SettingsCard
          icon={<Trash2 size={appTheme.icon.feature} color={theme.colors.danger} />}
          title="Delete account"
          body="Permanently delete your account and personal data."
          destructive
          onPress={() => router.push('/delete-account' as never)}
        />
      ) : (
        <SettingsCard
          icon={<Trash2 size={appTheme.icon.feature} color={theme.colors.danger} />}
          title="Account deletion"
          body="See how to request deletion of an existing Magicbooklet account."
          external
          onPress={() => void Linking.openURL(`${env.siteUrl}/delete-account`)}
        />
      )}

      {supportDetails ? (
        <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>
          {supportDetails}
        </AppText>
      ) : null}

      {versionLabel ? (
        // Long-press copies this session's media diagnostics: the report to send
        // when images stop loading, taken before the app is restarted.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={versionLabel}
          accessibilityHint="Long-press to copy media diagnostics."
          onLongPress={() => void copyMediaDiagnostics(versionLabel)}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>
            {versionLabel}
          </AppText>
        </Pressable>
      ) : null}
    </Screen>
  );
}

async function copyMediaDiagnostics(versionLabel: string) {
  const diagnostics = readMediaDiagnostics();
  await copyToClipboard(
    formatMediaDiagnosticsReport({ versionLabel, diagnostics, now: Date.now() }),
    'Media diagnostics copied'
  );
  const summary = summarizeMediaDiagnostics(diagnostics.events);
  showMessageDialog({
    title: 'Media diagnostics copied',
    message: summary.total
      ? `${summary.total} media events this session: ${summary.stalls} stalled, ${summary.failures} failed, ${summary.recoveries} recovered.`
      : 'No media problems recorded this session.',
  });
}

const APPEARANCE_LABELS: Record<AppearancePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Follow the phone, or hold one scheme whatever it says. Drawn as the app's
 * segmented control (the same track and solid selected fill as `ModeTabs` on
 * the sign-in screen and `ProfileSegment`) with radio semantics, because this
 * picks a setting rather than switching a view. The change lands in the same
 * frame; there is nothing to confirm.
 */
function AppearanceSetting() {
  const theme = useAppTheme();
  const preference = useAppearancePreference();
  const body = preference === 'system'
    ? `Matches your phone — ${theme.scheme === 'dark' ? 'dark' : 'light'} right now.`
    : `Stays ${preference} whatever your phone uses.`;

  return (
    <Card style={{ gap: 14 }}>
      <View style={{ gap: 3 }}>
        <AppText variant="cardTitle">Appearance</AppText>
        <AppText variant="bodySm" color="muted">{body}</AppText>
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Appearance"
        style={{
          flexDirection: 'row',
          gap: 4,
          padding: 4,
          borderRadius: 18,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surfaceInset,
        }}
      >
        {APPEARANCE_PREFERENCES.map((option) => {
          const active = option === preference;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityLabel={APPEARANCE_LABELS[option]}
              accessibilityState={{ checked: active }}
              onPress={() => {
                if (active) return;
                haptic.select();
                setAppearancePreference(option);
              }}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: appTheme.touch.compact,
                borderRadius: 14,
                borderCurve: 'continuous',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: active ? theme.colors.primaryFill : 'transparent',
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <AppText
                selectable={false}
                variant="label"
                color={active ? theme.colors.onPrimary : theme.colors.muted}
                numberOfLines={1}
              >
                {APPEARANCE_LABELS[option]}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </Card>
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
  const theme = useAppTheme();
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
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <AppText variant="cardTitle" color={destructive ? 'danger' : undefined}>{title}</AppText>
          <AppText variant="bodySm" color="muted">{body}</AppText>
        </View>
        <Trailing size={appTheme.icon.default} color={theme.colors.faint} />
      </Card>
    </Pressable>
  );
}
