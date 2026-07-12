import { useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { CheckCircle2, Copy, Gift, RotateCcw, Share2, ShoppingBag, UserPlus, UsersRound } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, Share, View } from 'react-native';

import {
  AppText,
  AppTextInput,
  Card,
  Kicker,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SectionTitle,
  StatusBlock,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { normalizeReferralCode } from '@/lib/referral-attribution';
import { appTheme } from '@/lib/theme';
import type { ReferralReward, ReferralStats } from '@/lib/types';

const DEFAULT_INVITER_PERCENT = 5;
const DEFAULT_INVITEE_PERCENT = 5;
const REFERRAL_DISCLOSURE = 'Referral link — I may earn bonus credits if you top up.';

export default function InviteScreen() {
  const { user, api } = useAuth();
  const overviewQuery = useQuery({
    queryKey: ['referrals-me', user?.id],
    enabled: Boolean(user),
    queryFn: api.getReferralOverview,
  });
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [isPreparingLink, setIsPreparingLink] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger' | 'neutral'; title: string; body?: string } | null>(null);

  useEffect(() => {
    if (overviewQuery.data?.shareUrl) setShareUrl(overviewQuery.data.shareUrl);
  }, [overviewQuery.data?.shareUrl]);

  if (!user) return <SignedOutInvite />;

  const program = overviewQuery.data?.program;
  const inviterPercent = program?.inviterPercent ?? DEFAULT_INVITER_PERCENT;
  const inviteePercent = program?.inviteeFirstPurchasePercent ?? DEFAULT_INVITEE_PERCENT;

  const ensureShareUrl = async () => {
    if (shareUrl) return shareUrl;
    const link = await api.createReferralLink();
    setShareUrl(link.shareUrl);
    return link.shareUrl;
  };

  const shareInvite = async () => {
    setIsPreparingLink(true);
    setNotice(null);
    try {
      const url = await ensureShareUrl();
      const result = await Share.share({
        title: 'Invite & Earn with Magicbooklet',
        message: `Try Magicbooklet and get ${inviteePercent}% bonus credits on your first top-up. ${REFERRAL_DISCLOSURE}\n${url}`,
        url,
      });
      if (result.action !== Share.dismissedAction) {
        setNotice({ tone: 'success', title: 'Invite ready', body: 'Your referral link was shared.' });
      }
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: 'Could not share invite',
        body: error instanceof Error ? error.message : 'Check your connection, then try again.',
      });
    } finally {
      setIsPreparingLink(false);
    }
  };

  const copyInvite = async () => {
    setIsPreparingLink(true);
    setNotice(null);
    try {
      const url = await ensureShareUrl();
      await Clipboard.setStringAsync(
        `Try Magicbooklet and get ${inviteePercent}% bonus credits on your first top-up. ${REFERRAL_DISCLOSURE}\n${url}`
      );
      const message = 'Invite message, referral disclosure, and link copied.';
      setNotice({ tone: 'success', title: 'Link copied', body: message });
      AccessibilityInfo.announceForAccessibility?.(message);
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: 'Could not copy link',
        body: error instanceof Error ? error.message : 'Check your connection, then try again.',
      });
    } finally {
      setIsPreparingLink(false);
    }
  };

  return (
    <Screen>
      <SectionTitle
        eyebrow="Invite & Earn"
        title="Create more, together."
        body={`Friends get ${inviteePercent}% bonus credits on their first top-up. You earn ${inviterPercent}% bonus credits whenever they top up.`}
      />

      <Card accent="commerce" padding="lg">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', backgroundColor: `${appTheme.colors.commerce}1f` }}>
            <Gift size={28} color={appTheme.colors.commerce} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Kicker color="commerce">Share the magic</Kicker>
            <AppText variant="sectionTitle">Earn {inviterPercent}% in credits</AppText>
            <AppText variant="bodySm" color="muted">On every verified credit-pack purchase by friends you refer.</AppText>
          </View>
        </View>
        <PrimaryButton
          label="Share invite"
          accent="commerce"
          loading={isPreparingLink}
          onPress={() => void shareInvite()}
          accessibilityHint="Opens the native share sheet with your referral disclosure and link"
        />
        <SecondaryButton
          label="Copy referral link"
          disabled={isPreparingLink}
          onPress={() => void copyInvite()}
          accessibilityHint="Copies your invite message, referral disclosure, and personal referral link"
        />
        <AppText variant="caption" color="muted">{REFERRAL_DISCLOSURE}</AppText>
      </Card>

      {notice ? <StatusBlock tone={notice.tone} title={notice.title} body={notice.body} /> : null}

      {overviewQuery.isLoading ? (
        <StatusBlock title="Loading invite activity" body="Fetching your visits, signups, rewards, and personal link." />
      ) : null}

      {overviewQuery.error ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock tone="danger" title="Could not load invite activity" body="Your referral link and existing rewards are safe. Check your connection, then retry." />
          <SecondaryButton label="Retry invite activity" onPress={() => void overviewQuery.refetch()} />
        </View>
      ) : null}

      {overviewQuery.data ? (
        <>
          <ReferralMetrics stats={overviewQuery.data.stats} />
          <RewardActivity rewards={overviewQuery.data.recentRewards} />
        </>
      ) : null}

      <Card variant="soft">
        <AppText variant="cardTitle">How rewards work</AppText>
        <RuleRow icon={<UserPlus size={19} color={appTheme.colors.info} />} text={`A new friend joins within ${program?.attributionWindowDays ?? 30} days of opening your link.`} />
        <RuleRow icon={<ShoppingBag size={19} color={appTheme.colors.commerce} />} text={`They receive ${inviteePercent}% bonus credits on their first verified credit-pack purchase.`} />
        <RuleRow icon={<CheckCircle2 size={19} color={appTheme.colors.success} />} text={`You receive ${inviterPercent}% bonus credits on each verified credit-pack purchase they make.`} />
        <RuleRow icon={<RotateCcw size={19} color={appTheme.colors.warning} />} text="Refunded or disputed purchases reverse the matching bonus credits." />
        <AppText variant="caption" color="faint">Bonus credits are for creation tools, have no cash value, and cannot unlock marketplace resources.</AppText>
      </Card>
    </Screen>
  );
}

function SignedOutInvite() {
  const [codeInput, setCodeInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const applyCode = () => {
    const code = normalizeReferralCode(codeInput);
    if (!code) {
      setError('Enter the code or full magicbooklet.com invite link you received.');
      return;
    }
    setError(null);
    router.push({ pathname: '/r/[code]', params: { code } } as never);
  };

  return (
    <Screen>
      <SectionTitle
        eyebrow="Invite & Earn"
        title="Share creativity. Earn credits."
        body="Sign in to get your personal link, or apply an invite code you received before creating a new account."
      />
      <Card accent="commerce" padding="lg">
        <View style={{ alignItems: 'center', gap: 12, paddingVertical: 8 }}>
          <View style={{ width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: `${appTheme.colors.commerce}1f` }}>
            <Gift size={32} color={appTheme.colors.commerce} />
          </View>
          <AppText variant="sectionTitle" style={{ textAlign: 'center' }}>Friends create better together</AppText>
          <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
            New users can receive 5% bonus credits on their first top-up. Inviters earn 5% when referred friends top up.
          </AppText>
        </View>
        <PrimaryButton
          label="Sign in to invite friends"
          accent="commerce"
          onPress={() => router.push({ pathname: '/auth', params: { returnTo: '/invite' } } as never)}
        />
      </Card>

      <Card variant="soft">
        <AppText variant="cardTitle">Have an invite code?</AppText>
        <AppText variant="bodySm" color="muted">If you installed the app before opening the link, paste the code or full referral link here.</AppText>
        <AppTextInput
          label="Invite code"
          accessibilityLabel="Invite code or referral link"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Code or https://magicbooklet.com/r/..."
          value={codeInput}
          onChangeText={(value) => {
            setCodeInput(value);
            if (error) setError(null);
          }}
          onSubmitEditing={applyCode}
          returnKeyType="go"
        />
        {error ? <StatusBlock tone="danger" title="Invite code not recognized" body={error} /> : null}
        <PrimaryButton label="Apply invite code" disabled={!codeInput.trim()} onPress={applyCode} />
      </Card>
    </Screen>
  );
}

function ReferralMetrics({ stats }: { stats: ReferralStats }) {
  const metrics = [
    { label: 'Link visits', value: stats.visits, icon: Share2, color: appTheme.colors.info },
    { label: 'Friends joined', value: stats.signups, icon: UsersRound, color: appTheme.colors.primary },
    { label: 'Purchasers', value: stats.purchasers, icon: ShoppingBag, color: appTheme.colors.commerce },
    { label: 'Credits earned', value: stats.creditsEarned, icon: Gift, color: appTheme.colors.success },
  ];

  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <AppText variant="sectionTitle">Your invite activity</AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: appTheme.spacing.gap }}>
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <View key={metric.label} style={{ width: '48%', flexGrow: 1 }}>
              <Card variant="soft" padding="sm" style={{ minHeight: 112 }}>
                <Icon size={20} color={metric.color} />
                <AppText variant="sectionTitle" style={{ fontVariant: ['tabular-nums'] }}>{metric.value.toLocaleString('en-IN')}</AppText>
                <AppText variant="caption" color="muted">{metric.label}</AppText>
              </Card>
            </View>
          );
        })}
      </View>
      {stats.creditsReversed > 0 ? (
        <StatusBlock tone="warning" title={`${stats.creditsReversed.toLocaleString('en-IN')} credits reversed`} body="A referred purchase was refunded or disputed." />
      ) : null}
    </View>
  );
}

function RewardActivity({ rewards }: { rewards: ReferralReward[] }) {
  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <AppText variant="sectionTitle">Recent rewards</AppText>
      {rewards.length === 0 ? (
        <StatusBlock title="No rewards yet" body="Share your link to start filling this activity list." />
      ) : (
        <Card variant="soft" padding="sm">
          {rewards.map((reward, index) => (
            <View key={reward.id}>
              <View accessible accessibilityLabel={`${reward.status === 'reversed' ? 'Reversed' : 'Earned'} ${reward.credits} credits`} style={{ minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
                <View style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: reward.status === 'reversed' ? appTheme.semantic.warning.background : appTheme.semantic.success.background }}>
                  {reward.status === 'reversed'
                    ? <RotateCcw size={18} color={appTheme.colors.warning} />
                    : <Gift size={18} color={appTheme.colors.success} />}
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <AppText variant="label">{reward.kind === 'invitee_first_purchase' ? 'Welcome bonus' : 'Friend top-up'}</AppText>
                  <AppText variant="caption" color="muted">{formatRewardDate(reward.createdAt)}</AppText>
                </View>
                <AppText variant="label" color={reward.status === 'reversed' ? 'warning' : 'success'} style={{ fontVariant: ['tabular-nums'] }}>
                  {reward.status === 'reversed' ? '-' : '+'}{reward.credits}
                </AppText>
              </View>
              {index < rewards.length - 1 ? <View style={{ height: 1, backgroundColor: appTheme.colors.borderSubtle }} /> : null}
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}

function RuleRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.surfaceStrong }}>{icon}</View>
      <AppText variant="bodySm" color="textSecondary" style={{ flex: 1, paddingTop: 6 }}>{text}</AppText>
    </View>
  );
}

function formatRewardDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Recent activity'
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
