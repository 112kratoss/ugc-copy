import { router, useLocalSearchParams } from 'expo-router';
import { CheckCircle2, Gift, Link2, ShieldCheck, UserPlus } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { AppText, Card, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  capturePendingReferral,
  claimPendingReferral,
  getPendingReferral,
  getRecentReferralClaim,
  normalizeReferralCode,
} from '@/lib/referral-attribution';
import { appTheme } from '@/lib/theme';

type InviteState =
  | { status: 'loading' }
  | { status: 'ready'; code: string; keptEarlierInvite: boolean }
  | { status: 'claimed'; code: string }
  | { status: 'ineligible'; code: string; reason?: string }
  | { status: 'error'; code: string | null; message: string; savedLocally: boolean; visitRecorded: boolean };

export default function ReferralLandingScreen() {
  const params = useLocalSearchParams<{ code?: string | string[]; next?: string | string[] }>();
  const { api, user, isLoading: isAuthLoading } = useAuth();
  const rawCode = Array.isArray(params.code) ? params.code[0] : params.code;
  const code = normalizeReferralCode(rawCode);
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  const destination = normalizeMobileReferralDestination(rawNext);
  const [state, setState] = useState<InviteState>({ status: 'loading' });
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function prepareInvite() {
      if (!code) {
        setState({ status: 'error', code: null, message: 'This invite code is incomplete or invalid.', savedLocally: false, visitRecorded: false });
        return;
      }

      setState({ status: 'loading' });
      try {
        const recentClaim = await getRecentReferralClaim(code);
        if (cancelled) return;
        if (recentClaim) {
          setState(recentClaim.claimed
            ? { status: 'claimed', code }
            : { status: 'ineligible', code, reason: recentClaim.reason });
          return;
        }

        const captured = await capturePendingReferral(api, code, { next: rawNext });
        if (cancelled) return;

        if (isAuthLoading) return;
        if (!user) {
          setState({ status: 'ready', code: captured.pending.code, keptEarlierInvite: captured.keptEarlierInvite });
          return;
        }

        const claim = await claimPendingReferral(api);
        if (cancelled) return;
        if (claim?.claimed) {
          setState({ status: 'claimed', code: captured.pending.code });
        } else {
          setState({ status: 'ineligible', code: captured.pending.code, reason: claim?.reason });
        }
      } catch (error) {
        if (cancelled) return;
        const pending = await getPendingReferral().catch(() => null);
        if (cancelled) return;
        setState({
          status: 'error',
          code,
          message: error instanceof Error ? error.message : 'Check your connection, then try again.',
          savedLocally: pending?.code === code,
          visitRecorded: Boolean(pending?.visitToken),
        });
      }
    }

    void prepareInvite();
    return () => {
      cancelled = true;
    };
  }, [api, code, isAuthLoading, rawNext, retryKey, user?.id]);

  const returnTo = code
    ? `/r/${encodeURIComponent(code)}${rawNext ? `?next=${encodeURIComponent(rawNext)}` : ''}`
    : '/invite';

  return (
    <Screen>
      <SectionTitle
        eyebrow="Magicbooklet invite"
        title="Your creative bonus is waiting."
        body="New users get 5% bonus credits on their first verified credit-pack purchase."
      />

      <Card accent="commerce" padding="lg">
        <View style={{ alignItems: 'center', gap: 12, paddingVertical: 8 }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: `${appTheme.colors.commerce}1f` }}>
            <Gift size={34} color={appTheme.colors.commerce} />
          </View>
          <AppText variant="sectionTitle" style={{ textAlign: 'center' }}>5% first top-up bonus</AppText>
          <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
            Create images, videos, motion, audio, prompts, and workflows with your bonus credits.
          </AppText>
        </View>
      </Card>

      {state.status === 'loading' ? (
        <StatusBlock title="Saving your invite" body="Securely connecting this invite to your device." />
      ) : null}

      {state.status === 'ready' ? (
        <>
          <StatusBlock
            tone={state.keptEarlierInvite ? 'info' : 'success'}
            title={state.keptEarlierInvite ? 'Your first invite is already saved' : 'Invite saved'}
            body={state.keptEarlierInvite
              ? 'Magicbooklet keeps the first eligible invite opened on this device.'
              : 'Create your new account now. The invite will be claimed after authentication.'}
          />
          <PrimaryButton
            label="Create account"
            accent="commerce"
            onPress={() => router.push({ pathname: '/auth', params: { mode: 'signup', returnTo } } as never)}
          />
          <SecondaryButton
            label="I already have an account"
            onPress={() => router.push({ pathname: '/auth', params: { mode: 'login', returnTo } } as never)}
          />
        </>
      ) : null}

      {state.status === 'claimed' ? (
        <>
          <StatusBlock tone="success" title="Invite applied" body="Your 5% welcome bonus will be added to your first verified credit-pack purchase." />
          <PrimaryButton label="Continue to Magicbooklet" onPress={() => router.replace(destination as never)} />
          <SecondaryButton label="View Invite & Earn" onPress={() => router.replace('/invite' as never)} />
        </>
      ) : null}

      {state.status === 'ineligible' ? (
        <>
          <StatusBlock tone="warning" title="Invite not applied" body={claimReasonMessage(state.reason)} />
          <PrimaryButton label="Continue to Magicbooklet" onPress={() => router.replace(destination as never)} />
        </>
      ) : null}

      {state.status === 'error' ? (
        <>
          <StatusBlock
            tone="danger"
            title="Could not finish this invite"
            body={state.savedLocally
              ? `${state.visitRecorded ? 'The verified invite is saved on this device.' : 'The code is saved locally, but it has not been verified yet.'} ${state.message}`
              : state.message}
          />
          <PrimaryButton label="Retry invite" onPress={() => setRetryKey((value) => value + 1)} />
          {state.savedLocally && state.visitRecorded && !user ? (
            <SecondaryButton
              label="Create account with saved code"
              onPress={() => router.push({ pathname: '/auth', params: { mode: 'signup', returnTo } } as never)}
            />
          ) : null}
          <SecondaryButton label="Enter a different code" onPress={() => router.replace('/invite' as never)} />
        </>
      ) : null}

      <Card variant="soft">
        <Rule icon={<Link2 size={19} color={appTheme.colors.info} />} text="The first eligible invite opened within 30 days is used." />
        <Rule icon={<UserPlus size={19} color={appTheme.colors.primary} />} text="The bonus is available to new Magicbooklet accounts only." />
        <Rule icon={<CheckCircle2 size={19} color={appTheme.colors.success} />} text="Rewards are issued after payment verification." />
        <Rule icon={<ShieldCheck size={19} color={appTheme.colors.warning} />} text="Self-referrals, refunded purchases, and abuse do not qualify." />
      </Card>
    </Screen>
  );
}

function Rule({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.surfaceStrong }}>{icon}</View>
      <AppText variant="bodySm" color="textSecondary" style={{ flex: 1, paddingTop: 6 }}>{text}</AppText>
    </View>
  );
}

function claimReasonMessage(reason?: string) {
  switch (reason) {
    case 'self_referral':
      return 'You cannot apply your own referral link.';
    case 'already_attributed':
      return 'This account already has an inviter.';
    case 'account_not_new':
    case 'existing_account':
      return 'Invite bonuses are only available to new accounts.';
    case 'expired':
      return 'This invite is outside the 30-day attribution window.';
    case 'disabled':
      return 'This referral program is not currently active.';
    default:
      return 'This account is not eligible for this invite, but you can continue using Magicbooklet.';
  }
}

function normalizeMobileReferralDestination(value?: string) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/(tabs)';
  if (value === '/create') return '/(tabs)';
  if (/^\/create\/(?:image|video|motion)$/.test(value)) return value;
  if (value === '/pricing') return '/(tabs)/pricing';
  // Kept in step with NOTIFICATION_ROUTE_PATTERNS in lib/notifications.ts: both
  // decide which web paths an outside link may land a viewer on, and a path
  // allowed by one and refused by the other is always a bug in the stricter one.
  if (value === '/invite' || /^\/showcase\/[^/]+$/.test(value) || /^\/creators\/[^/]+$/.test(value)) {
    return value;
  }
  return '/(tabs)';
}
