import { useQuery } from '@tanstack/react-query';
import { useRef, useState, useSyncExternalStore } from 'react';
import { router } from 'expo-router';
import { ArrowUpRight, Ban, Bell, ChevronRight, CircleHelp, CreditCard, EyeOff, FileText, Gift, LogOut, ShieldCheck, Sparkles, Trash2, UserRound } from 'lucide-react-native';
import { ActivityIndicator, Linking, Platform, Pressable, View } from 'react-native';

import { AppText, Card, Screen, SectionTitle } from '@/components/ui';
import { AutoplaySetting } from '@/components/autoplay-setting';
import { OnboardingResumeCard } from '@/components/onboarding-resume-card';
import { useAiDataConsent } from '@/lib/ai-data-consent';
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
import { showConfirmDialog, showMessageDialog, type ConfirmDialogRequest, type MessageDialogRequest } from '@/lib/dialog';
import {
  formatMediaDiagnosticsReport,
  readMediaDiagnostics,
  summarizeMediaDiagnostics,
} from '@/lib/media-diagnostics';
import { haptic } from '@/lib/haptics';
import { canRevealNsfwInApp } from '@/lib/nsfw-reveal-policy';
import { CREDIT_BALANCE_LOADING_LABEL, formatCreditAmount } from '@/lib/pricing';
import { useAuth, type AccountDeletionOutcome } from '@/lib/auth';
import { env } from '@/lib/env';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

export default function SettingsScreen() {
  const theme = useAppTheme();
  const { user, isGuest, credits } = useAuth();
  const aiDataConsent = useAiDataConsent();
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

      <OnboardingResumeCard />

      <GroupLabel>Account</GroupLabel>

      <SettingsCard
        icon={<UserRound size={appTheme.icon.feature} color={theme.colors.primary} />}
        title="Profile"
        body={user?.email ?? 'Sign in to connect your creator profile.'}
        // Signing in comes back to Settings, not Home (audit 01-12).
        onPress={() => router.push(user ? '/profile' as never : { pathname: '/auth', params: { returnTo: '/settings' } } as never)}
      />

      <SettingsCard
        icon={<CreditCard size={appTheme.icon.feature} color={theme.colors.amber} />}
        title="Credits"
        body={credits === null ? CREDIT_BALANCE_LOADING_LABEL : `${formatCreditAmount(credits)} credits available on this account.`}
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

      {/* An account only: a guest's one session is this phone. */}
      {user ? <SignOutEverywhereCard /> : null}

      {isAppearanceChoiceAvailable() ? (
        <>
          <GroupLabel>Display</GroupLabel>
          <AppearanceSetting />
        </>
      ) : null}

      <GroupLabel>Playback</GroupLabel>
      <AutoplaySetting />

      <GroupLabel>Privacy</GroupLabel>

      <SettingsCard
        icon={<Sparkles size={appTheme.icon.feature} color={theme.colors.primary} />}
        title="AI data sharing"
        body={aiDataConsent.grantedAt
          ? 'Allowed on this phone. Your prompts and media go to AI services when you create.'
          : 'Not allowed on this phone. You’ll be asked before anything is sent to AI services.'}
        onPress={() => router.push('/ai-data-sharing' as never)}
      />

      {/* Blocks belong to an account, and this is the one place a block can be
          taken back: a blocked creator is left out of everywhere else. */}
      {user ? (
        <SettingsCard
          icon={<Ban size={appTheme.icon.feature} color={theme.colors.text} />}
          title="Blocked users"
          body="See whom you blocked, and unblock them."
          onPress={() => router.push('/blocked-users' as never)}
        />
      ) : null}

      {/* Only where a mature post can be revealed at all: Android never
          reveals one, so it has nothing to show here. */}
      {user && canRevealNsfwInApp(Platform.OS) ? <MatureContentSetting /> : null}

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
        <>
          {/* A guest only (D5): an account is deleted on its own screen. */}
          {isGuest ? <GuestDataDeletionCard /> : null}
          <SettingsCard
            icon={<Trash2 size={appTheme.icon.feature} color={theme.colors.danger} />}
            title="Account deletion"
            body="See how to request deletion of an existing Magicbooklet account."
            external
            onPress={() => void Linking.openURL(`${env.siteUrl}/delete-account`)}
          />
        </>
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

/** Asked before a guest's data goes: what goes with it, and how to keep it (D5). */
function guestDataDeletionConfirmation(credits: number | null): ConfirmDialogRequest {
  const guestCredits = credits !== null && credits > 0
    ? `${formatCreditAmount(credits)} ${credits === 1 ? 'credit' : 'credits'}`
    : 'any credits';
  return {
    title: 'Delete guest data?',
    message: `Your guest creations, uploads and ${guestCredits} are deleted for good. To keep them, create an account first.`,
    confirmLabel: 'Delete',
    destructive: true,
  };
}

/** Said once the deletion has the guest, and the phone is a new guest on Home. */
const GUEST_DATA_DELETED: MessageDialogRequest = {
  title: 'Guest data deleted',
  message: 'Your guest creations, uploads and credits are deleted and can’t be brought back. You’re now a new guest on this phone.',
};

/**
 * The answer was lost and Supabase could not say whether the deletion started:
 * the guest is still on this phone, and a retry settles it. The account
 * screen's and the web's sentence.
 */
const GUEST_DATA_DELETION_UNCONFIRMED: MessageDialogRequest = {
  title: 'Deletion not confirmed',
  message: 'We could not confirm the deletion. Check the connection and try again.',
};

/**
 * Why nothing was deleted, in words written for people: the server's own
 * sentence when it sent one for this. A refused session's is "Unauthorized", a
 * failure answered by the platform carries only its status, the server's "could
 * not start" names an account, and a server from before guests could delete
 * their data answers "Create an account to use this feature."
 */
function guestDataNotDeletedReason(error: unknown) {
  const { status, details, code } = (typeof error === 'object' && error !== null ? error : {}) as {
    status?: unknown;
    details?: unknown;
    code?: unknown;
  };
  const answeredWithoutJson = typeof status === 'number' && status >= 500
    && (typeof details !== 'object' || details === null);
  if (
    status === 401
    || answeredWithoutJson
    || code === 'ACCOUNT_DELETION_NOT_STARTED'
    || code === 'REGISTRATION_REQUIRED'
  ) {
    return 'The deletion did not go through.';
  }
  return error instanceof Error && error.message.trim() ? error.message : 'The deletion did not go through.';
}

/** What a guest deletion that did not go through says; nothing for a merged guest. */
function guestDataNotDeletedNotice(error: unknown): MessageDialogRequest | null {
  // A guest linked to an account meanwhile is on its way to the sign-in
  // screen, whose notice says why (409 SESSION_MERGED).
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SESSION_MERGED') {
    return null;
  }
  return {
    title: 'Guest data was not deleted',
    message: `${guestDataNotDeletedReason(error)} Nothing was deleted.`,
  };
}

/**
 * Deletes the guest and says what came of it: the notice to show, if any. Kept
 * out of the component, whose handler React Compiler would otherwise skip for
 * the branches inside this try.
 */
async function deleteGuestDataFor(deleteAccount: () => Promise<AccountDeletionOutcome>) {
  try {
    // No sign-in first: a guest has none to repeat.
    const outcome = await deleteAccount();
    return outcome === 'unconfirmed' ? GUEST_DATA_DELETION_UNCONFIRMED : GUEST_DATA_DELETED;
  } catch (error) {
    return guestDataNotDeletedNotice(error);
  }
}

/** Asked before every session of the account ends, in the web account menu's words. */
const SIGN_OUT_EVERYWHERE_CONFIRMATION: ConfirmDialogRequest = {
  title: 'Sign out of all devices?',
  message: 'You’ll be signed out here and on every other device.',
  confirmLabel: 'Sign out',
  destructive: true,
};

/**
 * The server could not confirm it (offline, timed out): this phone kept its
 * session, and the other devices may still be signed in, so it is said plainly
 * and the row is ready for another try.
 */
const SIGN_OUT_EVERYWHERE_FAILED: MessageDialogRequest = {
  title: 'Could not sign out of all devices',
  message: 'The sign-out did not go through, and you’re still signed in on this phone. Check your connection and try again.',
};

/**
 * Whether the sign-out everywhere went through. Kept out of the component,
 * whose handler React Compiler would otherwise skip for the branches inside
 * this try.
 */
async function signedOutEverywhere(signOutEverywhere: () => Promise<void>) {
  try {
    await signOutEverywhere();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends every session of the account, this phone's included (product decisions
 * 2026-10-17, item 9), behind one confirmation. While it runs the app-wide
 * sign-out cover is up, and it lands on the sign-in screen as the side menu's
 * Sign out does; the other devices drop out on their next request.
 */
function SignOutEverywhereCard() {
  const theme = useAppTheme();
  const { signOutEverywhere } = useAuth();
  // From the first tap until the answer: a second tap before the confirmation
  // is drawn asks nothing more.
  const busyRef = useRef(false);

  const signOutOfAllDevices = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const confirmed = await showConfirmDialog(SIGN_OUT_EVERYWHERE_CONFIRMATION);
    const failed = confirmed && !(await signedOutEverywhere(signOutEverywhere));
    busyRef.current = false;
    if (failed) showMessageDialog(SIGN_OUT_EVERYWHERE_FAILED);
  };

  return (
    <SettingsCard
      icon={<LogOut size={appTheme.icon.feature} color={theme.colors.text} />}
      title="Sign out of all devices"
      body="Sign out here and on every other phone or browser."
      action
      onPress={() => void signOutOfAllDevices()}
    />
  );
}

/**
 * The guest's own way to delete itself and what it made (D5): its creations,
 * uploads and credits, on the server, behind one confirmation. Drawn for a
 * guest only. The deletion ends the session as an account's does, and the
 * phone carries on as a fresh guest on Home, where the notice is said.
 */
function GuestDataDeletionCard() {
  const theme = useAppTheme();
  const { credits, deleteAccount } = useAuth();
  const [deleting, setDeleting] = useState(false);
  // From the first tap until the answer: a second tap before the confirmation
  // is drawn, or while the request is out, starts nothing.
  const busyRef = useRef(false);

  const deleteGuestData = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (!(await showConfirmDialog(guestDataDeletionConfirmation(credits)))) {
      busyRef.current = false;
      return;
    }
    setDeleting(true);
    const notice = await deleteGuestDataFor(() => deleteAccount());
    busyRef.current = false;
    setDeleting(false);
    if (notice) showMessageDialog(notice);
  };

  return (
    <SettingsCard
      icon={<Trash2 size={appTheme.icon.feature} color={theme.colors.danger} />}
      title="Delete guest data"
      body={deleting ? 'Deleting guest data…' : 'Permanently delete your guest creations, uploads and credits.'}
      destructive
      action
      busy={deleting}
      onPress={() => void deleteGuestData()}
    />
  );
}

/**
 * The account's mature-content setting, shown and never changed here: on iOS
 * an adult turns it on from the website (Apple's rule for mature user content),
 * then reveals a post at a time. Until this row, someone who had turned it on
 * could turn it off only from the next mature post they happened to open.
 */
function MatureContentSetting() {
  const theme = useAppTheme();
  const { api, user } = useAuth();
  const preferences = useQuery({
    queryKey: ['content-preferences', user?.id ?? null],
    enabled: Boolean(user),
    queryFn: api.getContentPreferences,
  });
  const state = preferences.data
    ? (preferences.data.showMature ? 'On. Mature posts can be revealed one at a time.' : 'Off. Mature posts stay covered.')
    : preferences.isError ? 'Could not be checked.' : null;

  return (
    <SettingsCard
      icon={<EyeOff size={appTheme.icon.feature} color={theme.colors.text} />}
      title="Mature content"
      body={state ? `${state} Change on the website.` : 'Change on the website.'}
      external
      onPress={() => void Linking.openURL(`${env.siteUrl}/profile`)}
    />
  );
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
  action,
  busy,
  destructive,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onPress: () => void;
  /** Leaves the app: link semantics and a trailing arrow instead of the drill-down chevron. */
  external?: boolean;
  /**
   * Does something here, behind a confirmation, rather than opening a screen:
   * no drill-down chevron, which promises another page (HIG disclosure).
   */
  action?: boolean;
  /** The action is under way: the row says so, shows activity, and takes no tap. */
  busy?: boolean;
  destructive?: boolean;
}) {
  const theme = useAppTheme();
  const Trailing = external ? ArrowUpRight : action ? null : ChevronRight;
  return (
    <Pressable
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={`${title}. ${body}`}
      accessibilityHint={external ? 'Opens in your browser.' : undefined}
      // Booleans in every state: on Android a busy that goes back to undefined
      // stays, and the guest row read "busy" after its deletion had ended.
      accessibilityState={{ busy: Boolean(busy), disabled: Boolean(busy) }}
      accessibilityLiveRegion={busy ? 'polite' : undefined}
      disabled={busy}
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
        {busy ? (
          <ActivityIndicator color={theme.colors.muted} />
        ) : Trailing ? (
          <Trailing size={appTheme.icon.default} color={theme.colors.faint} />
        ) : null}
      </Card>
    </Pressable>
  );
}
