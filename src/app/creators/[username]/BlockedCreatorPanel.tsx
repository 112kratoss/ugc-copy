'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Loader2 } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { toastSafetyOutcome, unblockCreatorAfterConfirmation } from '@/lib/feed-safety-actions';

/**
 * Stands where a creator's posts would be when the viewer has blocked them (the
 * server render decides). The viewer is looking at whom they blocked, so the
 * block can be undone here as well as from the blocked list; the page is then
 * drawn again from the server, posts and Follow included.
 */
export function BlockedCreatorPanel({ creatorId, username }: { creatorId: string; username: string }) {
  const router = useRouter();
  const { session } = useAuth();
  const [isUnblocking, setIsUnblocking] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();
  const handle = `@${username}`;
  const isBusy = isUnblocking || isRefreshing;

  const handleUnblock = async () => {
    const accessToken = session?.access_token;
    if (!accessToken) {
      router.push(`/login?returnUrl=${encodeURIComponent(`/creators/${username}`)}`);
      return;
    }

    const outcome = await unblockCreatorAfterConfirmation({
      userId: creatorId,
      creatorLabel: handle,
      accessToken,
      onSend: () => setIsUnblocking(true),
    });
    toastSafetyOutcome(outcome);
    setIsUnblocking(false);
    // The button stays busy until the unblocked page replaces this panel.
    if (outcome.status === 'done') startRefresh(() => router.refresh());
  };

  return (
    <section
      aria-labelledby="blocked-creator-title"
      className="mt-7 flex min-h-56 flex-col items-center justify-center rounded-[24px] border border-white/8 bg-[#111215] px-6 py-10 text-center"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-zinc-400">
        <Ban className="h-5 w-5" aria-hidden />
      </span>
      <h2 id="blocked-creator-title" className="mt-4 text-lg font-bold text-white">
        You blocked {handle}
      </h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
        You won&apos;t see their posts, and neither of you can follow the other.
      </p>
      <button
        type="button"
        onClick={() => void handleUnblock()}
        disabled={isBusy}
        aria-busy={isBusy}
        className="ui-focus-ring mt-6 inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {isBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        {isBusy ? 'Unblocking…' : 'Unblock'}
      </button>
    </section>
  );
}
