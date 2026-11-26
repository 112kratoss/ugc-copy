'use client';

import clsx from 'clsx';
import { Loader2, Megaphone, MessageSquare, MessageSquareOff, RefreshCw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Pill, StatusCallout, Surface, Text } from '@/components/DesignSystem';
import SkeletonLoader from '@/components/SkeletonLoader';
import { markSupportUpdatesSeen, noteSupportUpdatesLatest } from '@/lib/support-updates-unread';

import {
  SUPPORT_HUB_WORDS,
  appendSupportUpdates,
  supportUpdateCommentWords,
  supportUpdateDateLabel,
  supportUpdatePreview,
  type SupportUpdate,
} from '../../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

import SupportHubReactions from './SupportHubReactions';
import { fetchSupportUpdatesPage, supportHubSignInHref, useSupportHubReaction } from './support-hub-client';

type UpdatesState =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
    status: 'ready';
    updates: SupportUpdate[];
    nextCursor: string | null;
    /** When the newest update was published, from the first page. */
    latestAt: string | null;
    /** When the first page came, the day its dates are said from ("Today"). */
    readAt: number;
  };

const SIGN_IN_HREF = supportHubSignInHref('updates');

/** The post an update is: its page holds the comments. */
function updatePath(update: Pick<SupportUpdate, 'id'>) {
  return `/showcase/${encodeURIComponent(update.id)}`;
}

function UpdatesSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading updates…</span>
      {Array.from({ length: 3 }, (_, index) => (
        <Surface key={index} variant="card" padding="md" className="space-y-3">
          <SkeletonLoader className="h-6 w-28" />
          <SkeletonLoader className="h-6 w-3/5" />
          <SkeletonLoader className="h-4 w-full" />
          <SkeletonLoader className="h-4 w-2/3" />
        </Surface>
      ))}
    </div>
  );
}

function UpdateCard({
  update,
  readAt,
  canReact,
  busy,
  onReact,
}: {
  update: SupportUpdate;
  readAt: number;
  canReact: boolean;
  busy: boolean;
  onReact: (update: SupportUpdate, emoji: SupportUpdate['myReaction']) => void;
}) {
  const title = update.title.trim() || SUPPORT_HUB_WORDS.kinds[update.kind];
  const preview = supportUpdatePreview(update.body);
  const commentWords = supportUpdateCommentWords(update.commentCount, update.commentsLocked);
  const CommentIcon = update.commentsLocked && update.commentCount === 0 ? MessageSquareOff : MessageSquare;

  return (
    <article className="relative rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-5 transition-colors hover:border-[var(--ui-border-default)] sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Pill accent={update.kind === 'shipped' ? 'workflow' : 'neutral'} icon={update.kind === 'shipped' ? Sparkles : Megaphone}>
          {SUPPORT_HUB_WORDS.kinds[update.kind]}
        </Pill>
        <time dateTime={update.createdAt} className="text-xs font-semibold text-[var(--ui-text-faint)]">
          {supportUpdateDateLabel(update.createdAt, new Date(readAt))}
        </time>
      </div>
      <Text as="h2" variant="cardTitle" className="mt-3">
        {/* The title's link covers the card (its ::after), so a press anywhere on it opens the post;
            the reactions and the comments link sit above it. */}
        <Link
          href={updatePath(update)}
          prefetch={false}
          className="ui-focus-ring rounded-lg after:absolute after:inset-0 after:rounded-3xl"
        >
          {title}
        </Link>
      </Text>
      {preview ? <Text variant="bodySm" className="mt-2">{preview}</Text> : null}
      <div className="relative z-10 mt-4 flex flex-wrap items-center justify-between gap-3">
        <SupportHubReactions
          subject={title}
          reactions={update.reactions}
          myReaction={update.myReaction}
          canReact={canReact}
          signInHref={SIGN_IN_HREF}
          busy={busy}
          onReact={(emoji) => onReact(update, emoji)}
        />
        <Link
          href={`${updatePath(update)}#comments`}
          prefetch={false}
          aria-label={`${SUPPORT_HUB_WORDS.openComments}: ${commentWords}`}
          className="ui-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-[var(--ui-text-muted)] transition-colors hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
        >
          <CommentIcon className="h-4 w-4" aria-hidden />
          {commentWords}
        </Link>
      </div>
    </article>
  );
}

/**
 * Help & Support's Updates (owner, 2026-11-26): news from the Magicbooklet
 * team and features just shipped, newest first, 20 to a page. Each is a post
 * of the official account, so a card opens its post page, where its comments
 * are. Looking at the list marks it seen on this device, which takes the
 * unread dot away here and on the shell's Help & feedback.
 */
export default function SupportUpdatesPanel({
  active,
  accessToken,
  canReact,
}: {
  /** The tab is open: what it shows is looked at. */
  active: boolean;
  accessToken: string | null;
  /** A registered account: reactions are its own. */
  canReact: boolean;
}) {
  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);
  const getAccessToken = useCallback(() => tokenRef.current, []);

  const [state, setState] = useState<UpdatesState>({ status: 'loading' });
  // Each Try again reads the first page anew.
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle');

  useEffect(() => {
    const controller = new AbortController();
    fetchSupportUpdatesPage({ accessToken: tokenRef.current, signal: controller.signal })
      .then((page) => {
        setState({
          status: 'ready',
          updates: page.updates,
          nextCursor: page.nextCursor,
          latestAt: page.latestAt,
          readAt: Date.now(),
        });
        noteSupportUpdatesLatest(page.latestAt);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      });
    return () => controller.abort();
  }, [attempt]);

  // Looked at: the newest update the list shows is seen on this device, once
  // the tab is open in a page someone can see. A list read in a background
  // browser tab waits until the page is shown.
  const shownLatestAt = state.status === 'ready' ? state.latestAt : null;
  useEffect(() => {
    if (!active || !shownLatestAt) return undefined;
    const markIfShown = () => {
      if (document.visibilityState === 'visible') markSupportUpdatesSeen(shownLatestAt);
    };
    markIfShown();
    document.addEventListener('visibilitychange', markIfShown);
    return () => document.removeEventListener('visibilitychange', markIfShown);
  }, [active, shownLatestAt]);

  const patch = useCallback((id: string, change: Pick<SupportUpdate, 'reactions' | 'myReaction'>) => {
    setState((current) => (current.status === 'ready'
      ? { ...current, updates: current.updates.map((update) => (update.id === id ? { ...update, ...change } : update)) }
      : current));
  }, []);
  const { react, pending } = useSupportHubReaction({ kind: 'update', getAccessToken, patch });

  const retry = () => {
    setState({ status: 'loading' });
    setMore('idle');
    setAttempt((current) => current + 1);
  };

  const showMore = async () => {
    if (state.status !== 'ready' || !state.nextCursor || more === 'loading') return;
    setMore('loading');
    try {
      const page = await fetchSupportUpdatesPage({ cursor: state.nextCursor, accessToken: tokenRef.current });
      setState((current) => (current.status === 'ready'
        ? { ...current, updates: appendSupportUpdates(current.updates, page.updates), nextCursor: page.nextCursor }
        : current));
      setMore('idle');
    } catch {
      setMore('failed');
    }
  };

  if (state.status === 'loading') return <UpdatesSkeleton />;

  if (state.status === 'failed') {
    return (
      <div>
        <StatusCallout tone="danger" icon={RefreshCw} title={SUPPORT_HUB_WORDS.updatesLoadFailed} />
        <button type="button" onClick={retry} className="ui-button ui-button-primary ui-focus-ring mt-5">
          <RefreshCw className="h-4 w-4" aria-hidden />
          {SUPPORT_HUB_WORDS.tryAgain}
        </button>
      </div>
    );
  }

  if (state.updates.length === 0) {
    return (
      <Surface variant="soft" padding="lg" className="text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)]">
          <Megaphone className="h-5 w-5" aria-hidden />
        </span>
        <Text as="h2" variant="cardTitle" className="mt-4">{SUPPORT_HUB_WORDS.updatesEmptyTitle}</Text>
        <Text variant="bodySm" className="mx-auto mt-2 max-w-lg">{SUPPORT_HUB_WORDS.updatesEmptyBody}</Text>
      </Surface>
    );
  }

  return (
    <div>
      <ul className="flex flex-col gap-4">
        {state.updates.map((update) => (
          <li key={update.id}>
            <UpdateCard
              update={update}
              readAt={state.readAt}
              canReact={canReact}
              busy={pending.has(update.id)}
              onReact={(item, emoji) => void react(item, emoji)}
            />
          </li>
        ))}
      </ul>

      {state.nextCursor ? (
        <div className="mt-6 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => void showMore()}
            disabled={more === 'loading'}
            aria-busy={more === 'loading' || undefined}
            className={clsx('ui-button ui-button-secondary ui-focus-ring', more === 'loading' && 'cursor-wait opacity-60')}
          >
            {more === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {SUPPORT_HUB_WORDS.loadMore}
          </button>
          {more === 'failed' ? (
            <p role="alert" className="text-center text-sm text-[var(--ui-text-secondary)]">{SUPPORT_HUB_WORDS.updatesLoadFailed}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
