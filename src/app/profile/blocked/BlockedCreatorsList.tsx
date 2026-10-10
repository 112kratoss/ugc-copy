'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck, UserRound } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { toastSafetyOutcome, unblockCreatorAfterConfirmation } from '@/lib/feed-safety-actions';
import { listBlockedCreators, type BlockedCreator } from '@/lib/moderation-client';

type ListState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; blockedUsers: BlockedCreator[]; hasMore: boolean };

/** `@handle`, as a card names its creator; their name when they have no handle. */
function creatorLabel(creator: BlockedCreator): string {
  return creator.username ? `@${creator.username}` : creator.name;
}

function formatBlockedDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function BlockedCreatorsList() {
  const { session } = useAuth();
  const accessToken = session?.access_token ?? null;
  // The list is the account's, not the token's: the reading keys on being
  // signed in and takes the token from a ref, so a refreshed token is no reason
  // to read the list again. Effects run in the order they are written, so the
  // ref is current by the time the reading below starts.
  const accessTokenRef = useRef(accessToken);
  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);
  const isSignedIn = Boolean(accessToken);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  // The people whose unblock has been answered "yes". Their rows are left out
  // the moment the answer is given: a button that waits on the network reads as
  // a press that did not land. Left out, not taken off the list: when the
  // server refuses, taking the id out again puts the row back in its place,
  // whoever else was unblocked meanwhile.
  const [unblockedIds, setUnblockedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const token = accessTokenRef.current;
    if (!isSignedIn || !token) return;
    const controller = new AbortController();
    listBlockedCreators({ accessToken: token, signal: controller.signal })
      .then((list) => {
        if (!controller.signal.aborted) setState({ status: 'ready', ...list });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'failed',
          message: error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.',
        });
      });
    return () => controller.abort();
  }, [attempt, isSignedIn]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  }, []);

  const unblock = async (creator: BlockedCreator) => {
    if (!accessToken || state.status !== 'ready') return;
    const listWasCut = state.hasMore;
    const outcome = await unblockCreatorAfterConfirmation({
      userId: creator.id,
      creatorLabel: creatorLabel(creator),
      accessToken,
      onSend: () => setUnblockedIds((current) => new Set(current).add(creator.id)),
    });
    toastSafetyOutcome(outcome);
    if (outcome.status === 'failed') {
      // Nobody was unblocked: the row is drawn again, where it was.
      setUnblockedIds((current) => {
        const next = new Set(current);
        next.delete(creator.id);
        return next;
      });
    }
    // A list cut at its limit has a place free now: it is read again, quietly,
    // for the people blocked before the ones shown.
    if (outcome.status === 'done' && listWasCut) setAttempt((current) => current + 1);
  };

  const loading = (
    <div role="status" aria-label="Loading blocked users" className="space-y-3">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-[76px] animate-pulse rounded-[22px] border border-white/8 bg-[var(--ui-surface-1)]" />
      ))}
    </div>
  );

  if (state.status === 'loading') return loading;

  if (state.status === 'failed') {
    return (
      <div role="alert" className="flex flex-col items-start gap-4 rounded-[24px] border border-rose-400/20 bg-rose-500/5 p-6">
        <p className="text-sm leading-6 text-rose-100">Could not load your blocked users. {state.message}</p>
        <button
          type="button"
          onClick={retry}
          className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/12 bg-white/[0.05] px-4 text-sm font-bold text-white transition hover:bg-white/[0.09]"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Try again
        </button>
      </div>
    );
  }

  const blockedUsers = state.blockedUsers.filter((creator) => !unblockedIds.has(creator.id));

  // Every row shown has been unblocked, and the list was cut: there are earlier
  // blocks to read, so this is not the empty list.
  if (blockedUsers.length === 0 && state.hasMore) return loading;

  if (blockedUsers.length === 0) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center rounded-[24px] border border-white/8 bg-[var(--ui-surface-1)] px-6 text-center">
        <ShieldCheck className="h-7 w-7 text-zinc-500" aria-hidden />
        <h2 className="mt-4 text-lg font-bold text-white">You have not blocked anyone</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-500">
          Block someone from the menu on their post or their page, and they will be listed here.
        </p>
      </div>
    );
  }

  return (
    <>
      <ul aria-label="Blocked users" className="space-y-3">
        {blockedUsers.map((creator) => {
          const blockedOn = formatBlockedDate(creator.blockedAt);
          return (
            <li
              key={creator.id}
              className="flex min-h-[76px] items-center gap-3 rounded-[22px] border border-white/8 bg-[var(--ui-surface-1)] px-4 py-3 sm:gap-4 sm:px-5"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-900 text-zinc-500">
                {creator.avatar ? (
                  // A list of at most a few dozen small avatars, off the landing pages: the plain tag is enough.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={creator.avatar} alt="" className="h-full w-full object-cover" />
                ) : (
                  <UserRound className="h-5 w-5" aria-hidden />
                )}
              </span>
              {/* The handle and the day on lines of their own: on one line a narrow screen cut the day off, and the day is what tells two blocks apart. */}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-white">{creator.name}</span>
                {creator.username ? (
                  <span className="mt-0.5 block truncate text-xs text-zinc-500">@{creator.username}</span>
                ) : null}
                {blockedOn ? (
                  <span className="mt-0.5 block truncate text-xs text-zinc-500">Blocked {blockedOn}</span>
                ) : null}
              </span>
              <button
                type="button"
                onClick={() => void unblock(creator)}
                aria-label={`Unblock ${creatorLabel(creator)}`}
                className="ui-focus-ring inline-flex min-h-11 shrink-0 items-center rounded-full border border-white/12 bg-white/[0.05] px-4 text-sm font-bold text-white transition hover:border-white/20 hover:bg-white/[0.09]"
              >
                Unblock
              </button>
            </li>
          );
        })}
      </ul>
      {state.hasMore ? (
        <p className="mt-4 text-center text-xs text-zinc-500">
          Showing your most recent blocks. Unblock someone to see the ones before them.
        </p>
      ) : null}
    </>
  );
}
