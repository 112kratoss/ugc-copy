'use client';

import {
  ArrowRight,
  Check,
  Copy,
  Gift,
  Loader2,
  RefreshCw,
  Share2,
  ShoppingBag,
  Sparkles,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/app/components/AuthProvider';
import {
  Kicker,
  Pill,
  StatusCallout,
  Surface,
  Text,
} from '@/app/components/DesignSystem';
import SkeletonLoader from '@/app/components/SkeletonLoader';

export const REFERRAL_DISCLOSURE = 'Referral link — I may earn bonus credits if you top up.';

export interface ReferralProgramSummary {
  program: {
    inviterPercent: number;
    inviteeFirstPurchasePercent: number;
    attributionWindowDays: number;
  };
  code: string | null;
  shareUrl: string | null;
  stats: {
    visits: number;
    signups: number;
    purchasers: number;
    creditsEarned: number;
    creditsReversed: number;
  };
  recentRewards: Array<{
    id: string;
    credits: number;
    status: string;
    kind: string;
    createdAt: string;
  }>;
}

type ActionTarget = 'share' | 'copy';
type ActionStatus = 'idle' | 'loading' | 'copied' | 'shared' | 'error';

interface ActionFeedback {
  target: ActionTarget | null;
  status: ActionStatus;
  message: string;
}

const idleAction: ActionFeedback = { target: null, status: 'idle', message: '' };
const numberFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

function toNonNegativeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function toAbsoluteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.abs(value) : 0;
}

function normalizeReferralSummary(value: unknown): ReferralProgramSummary {
  if (!value || typeof value !== 'object') {
    throw new Error('Referral response was empty.');
  }

  const input = value as Record<string, unknown>;
  const programInput = input.program && typeof input.program === 'object'
    ? input.program as Record<string, unknown>
    : {};
  const statsInput = input.stats && typeof input.stats === 'object'
    ? input.stats as Record<string, unknown>
    : {};
  const rewardInput = Array.isArray(input.recentRewards) ? input.recentRewards : [];

  const inviterPercent = toNonNegativeNumber(programInput.inviterPercent);
  const inviteeFirstPurchasePercent = toNonNegativeNumber(programInput.inviteeFirstPurchasePercent);
  const attributionWindowDays = toNonNegativeNumber(programInput.attributionWindowDays);

  if (!inviterPercent || !inviteeFirstPurchasePercent || !attributionWindowDays) {
    throw new Error('Referral program details are unavailable.');
  }

  return {
    program: {
      inviterPercent,
      inviteeFirstPurchasePercent,
      attributionWindowDays,
    },
    code: typeof input.code === 'string' && input.code.trim() ? input.code.trim() : null,
    shareUrl: typeof input.shareUrl === 'string' && input.shareUrl.trim() ? input.shareUrl.trim() : null,
    stats: {
      visits: toNonNegativeNumber(statsInput.visits),
      signups: toNonNegativeNumber(statsInput.signups),
      purchasers: toNonNegativeNumber(statsInput.purchasers),
      creditsEarned: toNonNegativeNumber(statsInput.creditsEarned),
      creditsReversed: toNonNegativeNumber(statsInput.creditsReversed),
    },
    recentRewards: rewardInput.flatMap((reward) => {
      if (!reward || typeof reward !== 'object') return [];
      const item = reward as Record<string, unknown>;
      if (typeof item.id !== 'string') return [];

      return [{
        id: item.id,
        credits: toAbsoluteNumber(item.credits),
        status: typeof item.status === 'string' ? item.status : 'earned',
        kind: typeof item.kind === 'string' ? item.kind : 'referral_reward',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      }];
    }),
  };
}

export function buildReferralShareText(inviteePercent: number) {
  return `Create with me on magicbooklet and get ${numberFormatter.format(inviteePercent)}% bonus credits on your first top-up.\n\n${REFERRAL_DISCLOSURE}`;
}

export function buildReferralCopyText(shareUrl: string, inviteePercent: number) {
  return `${buildReferralShareText(inviteePercent)}\n${shareUrl}`;
}

function getErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object') {
    const candidate = payload as { error?: unknown; message?: unknown };
    if (typeof candidate.error === 'string' && candidate.error.trim()) return candidate.error;
    if (typeof candidate.message === 'string' && candidate.message.trim()) return candidate.message;
  }
  return fallback;
}

async function readJson(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function formatRewardKind(kind: string) {
  const normalized = kind.toLowerCase();
  if (normalized.includes('invitee') || normalized.includes('friend')) {
    return 'Friend first top-up bonus';
  }
  if (normalized.includes('inviter') || normalized.includes('purchase')) {
    return 'Referral top-up reward';
  }
  return 'Referral reward';
}

function formatRewardDate(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Recently';

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
  }).format(new Date(timestamp));
}

function InviteSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading Invite & Earn" className="space-y-6">
      <span className="sr-only">Loading your invite rewards.</span>
      <SkeletonLoader className="h-52 rounded-[28px]" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <SkeletonLoader key={index} className="h-28 rounded-3xl" />
        ))}
      </div>
      <SkeletonLoader className="h-64 rounded-[28px]" />
    </div>
  );
}

export default function InviteClient() {
  const { session, isLoading: authLoading } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [summary, setSummary] = useState<ReferralProgramSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [action, setAction] = useState<ActionFeedback>(idleAction);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearActionTimer = useCallback(() => {
    if (actionTimerRef.current) {
      clearTimeout(actionTimerRef.current);
      actionTimerRef.current = null;
    }
  }, []);

  const finishAction = useCallback((next: ActionFeedback) => {
    clearActionTimer();
    setAction(next);
    actionTimerRef.current = setTimeout(() => {
      setAction(idleAction);
      actionTimerRef.current = null;
    }, 2600);
  }, [clearActionTimer]);

  useEffect(() => clearActionTimer, [clearActionTimer]);

  const loadSummary = useCallback(async () => {
    if (!accessToken) {
      if (!authLoading) {
        setError('Your session could not be verified. Sign in again and retry.');
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/referrals/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, 'Could not load your referral progress.'));
      }
      setSummary(normalizeReferralSummary(payload));
    } catch (loadError) {
      console.error('Failed to load referral summary:', loadError);
      setError(loadError instanceof Error ? loadError.message : 'Could not load your referral progress.');
    } finally {
      setLoading(false);
    }
  }, [accessToken, authLoading]);

  useEffect(() => {
    if (authLoading) return;

    const timeoutId = window.setTimeout(() => {
      void loadSummary();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [authLoading, loadSummary]);

  const createInviteLink = useCallback(async () => {
    if (!accessToken || !summary) return;

    setLinkLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/referrals/link', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, 'Could not create your invite link.'));
      }

      const link = payload && typeof payload === 'object'
        ? payload as { code?: unknown; shareUrl?: unknown }
        : {};
      const code = link.code;
      const shareUrl = link.shareUrl;
      if (typeof code !== 'string' || typeof shareUrl !== 'string') {
        throw new Error('Your invite link is not ready yet.');
      }
      setSummary((current) => current ? {
        ...current,
        code,
        shareUrl,
      } : current);
    } catch (linkError) {
      console.error('Failed to create referral link:', linkError);
      setError(linkError instanceof Error ? linkError.message : 'Could not create your invite link.');
    } finally {
      setLinkLoading(false);
    }
  }, [accessToken, summary]);

  const copyInvite = useCallback(async (target: ActionTarget) => {
    if (!summary?.shareUrl || !navigator.clipboard?.writeText) {
      finishAction({
        target,
        status: 'error',
        message: 'Copying is not supported in this browser. Select the link and copy it manually.',
      });
      return;
    }

    await navigator.clipboard.writeText(
      buildReferralCopyText(summary.shareUrl, summary.program.inviteeFirstPurchasePercent)
    );
    finishAction({
      target,
      status: 'copied',
      message: 'Invite message copied to your clipboard.',
    });
  }, [finishAction, summary]);

  const handleCopy = useCallback(async () => {
    if (action.status === 'loading') return;
    setAction({ target: 'copy', status: 'loading', message: 'Copying your invite message.' });
    try {
      await copyInvite('copy');
    } catch (copyError) {
      console.error('Failed to copy referral invite:', copyError);
      finishAction({
        target: 'copy',
        status: 'error',
        message: 'Could not copy your invite. Try again.',
      });
    }
  }, [action.status, copyInvite, finishAction]);

  const handleShare = useCallback(async () => {
    if (!summary?.shareUrl || action.status === 'loading') return;

    setAction({ target: 'share', status: 'loading', message: 'Opening your share options.' });
    const text = buildReferralShareText(summary.program.inviteeFirstPurchasePercent);

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'Join me on magicbooklet',
          text,
          url: summary.shareUrl,
        });
        finishAction({
          target: 'share',
          status: 'shared',
          message: 'Invite shared.',
        });
        return;
      } catch (shareError) {
        if (shareError instanceof DOMException && shareError.name === 'AbortError') {
          setAction(idleAction);
          return;
        }
      }
    }

    try {
      await copyInvite('share');
    } catch (copyError) {
      console.error('Failed to share referral invite:', copyError);
      finishAction({
        target: 'share',
        status: 'error',
        message: 'Could not share your invite. Try copying it instead.',
      });
    }
  }, [action.status, copyInvite, finishAction, summary]);

  const stats = useMemo(() => summary ? [
    { label: 'Link visits', value: summary.stats.visits, icon: Users, tone: 'text-sky-300' },
    { label: 'Friends joined', value: summary.stats.signups, icon: UserPlus, tone: 'text-violet-300' },
    { label: 'Friends topped up', value: summary.stats.purchasers, icon: ShoppingBag, tone: 'text-emerald-300' },
    { label: 'Credits earned', value: summary.stats.creditsEarned, icon: Sparkles, tone: 'text-amber-300' },
    { label: 'Credits reversed', value: summary.stats.creditsReversed, icon: RefreshCw, tone: 'text-rose-300' },
  ] : [], [summary]);
  const isZeroState = summary
    ? summary.stats.visits === 0 && summary.stats.signups === 0 && summary.stats.purchasers === 0
    : false;
  const busy = action.status === 'loading';

  return (
    <div className="ui-page ui-page-ambient min-h-screen pb-20">
      <div className="studio-shell relative z-10 py-8 sm:py-12">
        <header className="ui-enter relative mb-8 overflow-hidden rounded-[30px] border border-amber-300/15 bg-[var(--ui-surface-1)] p-6 shadow-[var(--ui-shadow-panel)] sm:p-8 lg:p-10">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_12%,rgba(242,185,94,0.18),transparent_32rem),radial-gradient(circle_at_18%_100%,rgba(255,122,89,0.1),transparent_28rem)]" aria-hidden />
          <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)] lg:items-end">
            <div>
              <Kicker icon={Gift} className="text-amber-300">Invite &amp; Earn</Kicker>
              <Text as="h1" variant="display" className="mt-4 max-w-[14ch]">
                Your friends get more. <span className="text-amber-300">You earn as they create.</span>
              </Text>
              <Text variant="bodySm" className="mt-4 max-w-2xl sm:text-base">
                Share your personal link. Friends receive bonus credits on their first verified top-up, and you receive bonus credits each time they top up.
              </Text>
            </div>

            {summary ? (
              <div className="grid grid-cols-2 gap-3" aria-label="Current referral offer">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4 sm:p-5">
                  <div className="text-3xl font-extrabold tracking-tight text-white">
                    {numberFormatter.format(summary.program.inviteeFirstPurchasePercent)}%
                  </div>
                  <p className="mt-2 text-sm font-bold text-zinc-200">for your friend</p>
                  <p className="mt-1 text-xs leading-5 text-zinc-400">On their first verified credit top-up</p>
                </div>
                <div className="rounded-3xl border border-amber-300/20 bg-amber-400/10 p-4 sm:p-5">
                  <div className="text-3xl font-extrabold tracking-tight text-amber-200">
                    {numberFormatter.format(summary.program.inviterPercent)}%
                  </div>
                  <p className="mt-2 text-sm font-bold text-amber-100">for you</p>
                  <p className="mt-1 text-xs leading-5 text-amber-100/65">On every verified credit top-up</p>
                </div>
              </div>
            ) : null}
          </div>
        </header>

        {(loading || authLoading) && !summary ? (
          <InviteSkeleton />
        ) : error && !summary ? (
          <StatusCallout
            tone="danger"
            icon={RefreshCw}
            title="Invite & Earn is unavailable"
            body={error}
            className="items-start"
          />
        ) : summary ? (
          <div className="space-y-8">
            {error ? (
              <StatusCallout
                tone="danger"
                icon={RefreshCw}
                title="Your invite link could not be updated"
                body={error}
              />
            ) : null}

            <section aria-labelledby="invite-link-heading" className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.55fr)]">
              <Surface variant="panel" padding="lg" className="relative overflow-hidden border-amber-300/15 sm:p-7">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-amber-400/[0.08] to-transparent" aria-hidden />
                <div className="relative">
                  <Pill accent="commerce" icon={Gift}>Your personal invite</Pill>
                  <h2 id="invite-link-heading" className="mt-4 text-2xl font-bold leading-tight tracking-tight text-[var(--ui-text-primary)] sm:text-3xl">
                    Share once. Earn when friends top up.
                  </h2>
                  <Text variant="bodySm" className="mt-3 max-w-2xl">
                    A friend must join through your link within {numberFormatter.format(summary.program.attributionWindowDays)} days. Rewards are added after a purchase is verified.
                  </Text>

                  {summary.shareUrl ? (
                    <div className="mt-6">
                      <label htmlFor="referral-link" className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--ui-text-faint)]">
                        Referral link
                      </label>
                      <div className="mt-2 flex min-h-12 items-center gap-3 rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4">
                        <input
                          id="referral-link"
                          readOnly
                          value={summary.shareUrl}
                          onFocus={(event) => event.currentTarget.select()}
                          className="min-w-0 flex-1 bg-transparent py-3 font-mono text-sm text-zinc-200 outline-none"
                        />
                        {summary.code ? (
                          <span className="hidden shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-[11px] font-bold text-zinc-400 sm:inline">
                            {summary.code}
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <button
                          type="button"
                          onClick={() => void handleShare()}
                          disabled={busy}
                          aria-busy={action.target === 'share' && busy}
                          className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985] disabled:cursor-wait disabled:opacity-60"
                        >
                          {action.target === 'share' && busy ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                          ) : action.target === 'share' && (action.status === 'shared' || action.status === 'copied') ? (
                            <Check className="h-4 w-4" aria-hidden />
                          ) : (
                            <Share2 className="h-4 w-4" aria-hidden />
                          )}
                          {action.target === 'share' && action.status === 'shared'
                            ? 'Shared'
                            : action.target === 'share' && action.status === 'copied'
                              ? 'Invite copied'
                              : action.target === 'share' && busy
                                ? 'Opening share…'
                                : 'Share invite'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCopy()}
                          disabled={busy}
                          aria-busy={action.target === 'copy' && busy}
                          className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-5 text-sm font-bold text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-surface-3)] active:scale-[0.985] disabled:cursor-wait disabled:opacity-60"
                        >
                          {action.target === 'copy' && busy ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                          ) : action.target === 'copy' && action.status === 'copied' ? (
                            <Check className="h-4 w-4 text-emerald-300" aria-hidden />
                          ) : (
                            <Copy className="h-4 w-4" aria-hidden />
                          )}
                          {action.target === 'copy' && action.status === 'copied'
                            ? 'Copied'
                            : action.target === 'copy' && busy
                              ? 'Copying…'
                              : 'Copy invite'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void createInviteLink()}
                      disabled={linkLoading}
                      className="ui-focus-ring mt-6 inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-6 text-sm font-extrabold text-[var(--ui-primary-on)] disabled:cursor-wait disabled:opacity-60"
                    >
                      {linkLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Gift className="h-4 w-4" aria-hidden />}
                      {linkLoading ? 'Creating link…' : 'Create my invite link'}
                    </button>
                  )}

                  <p className="mt-5 text-xs leading-5 text-zinc-500">
                    Shared messages include: “{REFERRAL_DISCLOSURE}”
                  </p>
                  <span className="sr-only" aria-live="polite" aria-atomic="true">
                    {action.message}
                  </span>
                </div>
              </Surface>

              <Surface as="aside" variant="card" padding="lg" className="sm:p-7">
                <Kicker>How it works</Kicker>
                <ol className="mt-5 space-y-5">
                  {[
                    { icon: Share2, title: 'Share your link', body: 'Send your personal invite anywhere you talk with creators.' },
                    { icon: UserPlus, title: 'A new friend joins', body: `They create an account through your link within ${numberFormatter.format(summary.program.attributionWindowDays)} days.` },
                    { icon: Sparkles, title: 'Both accounts earn', body: 'Verified top-ups add bonus creation credits automatically.' },
                  ].map((step, index) => (
                    <li key={step.title} className="flex gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-amber-300/15 bg-amber-400/10 text-amber-200">
                        <step.icon className="h-4 w-4" aria-hidden />
                      </span>
                      <div>
                        <p className="text-sm font-bold text-white"><span className="sr-only">Step {index + 1}: </span>{step.title}</p>
                        <p className="mt-1 text-xs leading-5 text-zinc-400">{step.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="mt-6 border-t border-white/8 pt-5 text-xs leading-5 text-zinc-500">
                  Bonus credits have no cash value. Refunds or chargebacks can reverse rewards. Eligibility and program terms apply.
                </p>
              </Surface>
            </section>

            <section aria-labelledby="referral-progress-heading">
              <div className="mb-4 flex items-end justify-between gap-4">
                <div>
                  <Kicker>Your progress</Kicker>
                  <h2 id="referral-progress-heading" className="mt-2 text-2xl font-bold leading-tight tracking-tight text-[var(--ui-text-primary)] sm:text-3xl">
                    Referral activity
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => void loadSummary()}
                  disabled={loading}
                  aria-label="Refresh referral activity"
                  className="ui-focus-ring inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-zinc-300 transition hover:bg-[var(--ui-surface-3)] disabled:cursor-wait disabled:opacity-60"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                {stats.map((stat) => (
                  <Surface key={stat.label} variant="card" padding="md" className="min-h-28">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-bold text-zinc-400">{stat.label}</p>
                      <stat.icon className={`h-4 w-4 ${stat.tone}`} aria-hidden />
                    </div>
                    <div className="mt-4 text-3xl font-extrabold tracking-tight text-white">
                      {numberFormatter.format(stat.value)}
                    </div>
                  </Surface>
                ))}
              </div>

              {isZeroState ? (
                <StatusCallout
                  tone="warning"
                  icon={Gift}
                  title="Your first referral starts here"
                  body="Share your invite to start tracking visits, new members, top-ups, and bonus credits."
                  className="mt-4"
                />
              ) : null}
            </section>

            <section aria-labelledby="recent-rewards-heading">
              <div className="mb-4 flex items-end justify-between gap-4">
                <div>
                  <Kicker>Credit history</Kicker>
                  <h2 id="recent-rewards-heading" className="mt-2 text-2xl font-bold leading-tight tracking-tight text-[var(--ui-text-primary)] sm:text-3xl">
                    Recent rewards
                  </h2>
                </div>
                <Link
                  href="/pricing"
                  className="ui-focus-ring hidden min-h-12 items-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm font-bold text-zinc-200 transition hover:bg-[var(--ui-surface-3)] sm:inline-flex"
                >
                  View credit packs <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>

              {summary.recentRewards.length > 0 ? (
                <Surface variant="card" padding="none" className="overflow-hidden">
                  <ul className="divide-y divide-white/8">
                    {summary.recentRewards.map((reward) => {
                      const reversed = reward.status.toLowerCase().includes('revers');
                      return (
                        <li key={reward.id} className="flex min-h-20 items-center gap-4 px-4 py-4 sm:px-5">
                          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${reversed ? 'border-rose-300/20 bg-rose-400/10 text-rose-200' : 'border-emerald-300/20 bg-emerald-400/10 text-emerald-200'}`}>
                            {reversed ? <RefreshCw className="h-4 w-4" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-bold text-white">{formatRewardKind(reward.kind)}</p>
                            <p className="mt-1 text-xs text-zinc-500">{formatRewardDate(reward.createdAt)}</p>
                          </div>
                          <div className={`shrink-0 text-right text-sm font-extrabold ${reversed ? 'text-rose-300' : 'text-emerald-300'}`}>
                            {reversed ? '−' : '+'}{numberFormatter.format(reward.credits)} credits
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </Surface>
              ) : (
                <Surface variant="soft" padding="lg" className="text-center">
                  <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-zinc-400">
                    <Sparkles className="h-5 w-5" aria-hidden />
                  </span>
                  <Text as="h3" variant="cardTitle" className="mt-4">No rewards yet</Text>
                  <Text variant="bodySm" className="mx-auto mt-2 max-w-lg">
                    When a referred friend completes an eligible top-up, the reward and any later adjustment will appear here.
                  </Text>
                </Surface>
              )}
            </section>
          </div>
        ) : null}

        {!loading && error && !summary ? (
          <button
            type="button"
            onClick={() => void loadSummary()}
            className="ui-focus-ring mt-5 inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)]"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}
