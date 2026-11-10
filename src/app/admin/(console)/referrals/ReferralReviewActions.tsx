'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import clsx from 'clsx';
import { Ban, Link2, Link2Off, Undo2 } from 'lucide-react';

import { Text } from '@/components/DesignSystem';
import { useFieldValueBeforeHydration } from '@/lib/use-field-value-before-hydration';

type ReferralReviewAction = 'block' | 'unblock' | 'disable_link' | 'enable_link';

const PENDING_LABELS: Record<ReferralReviewAction, string> = {
  block: 'Blocking...',
  unblock: 'Unblocking...',
  disable_link: 'Switching off...',
  enable_link: 'Switching on...',
};

export function ReferralReviewActions({
  attributionId,
  rewardState,
  inviterCode,
}: {
  attributionId: string;
  rewardState: 'eligible' | 'blocked';
  /** The inviter's link; absent once the inviter's account is gone. */
  inviterCode: { id: string; enabled: boolean } | null;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  // The table is drawn on the server: a reason typed before the page's script
  // ran never reached this state, and the buttons stayed disabled over it.
  const reasonRef = useRef<HTMLInputElement>(null);
  useFieldValueBeforeHydration(reasonRef, { drawn: '', onValue: setReason });
  const [pending, setPending] = useState<ReferralReviewAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rewardAction: ReferralReviewAction = rewardState === 'blocked' ? 'unblock' : 'block';
  const linkAction: ReferralReviewAction | null = inviterCode
    ? inviterCode.enabled ? 'disable_link' : 'enable_link'
    : null;
  const hasReason = reason.trim().length >= 3;

  const submit = async (action: ReferralReviewAction) => {
    setPending(action);
    setError(null);

    try {
      const response = await fetch('/api/admin/referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(action === 'block' || action === 'unblock'
            ? { attributionId }
            : { referralCodeId: inviterCode?.id }),
          reason: reason.trim(),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'The decision could not be saved.');
        return;
      }

      setReason('');
      router.refresh();
    } catch {
      setError('The decision could not be saved.');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="min-w-[220px] space-y-2">
      <input
        ref={reasonRef}
        type="text"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={1000}
        placeholder="Reason (required)"
        className={clsx(
          'ui-focus-ring w-full rounded-xl border border-[var(--ui-border-default)]',
          'bg-[var(--ui-surface-inset)] px-3 py-2 text-sm text-[var(--ui-text-primary)]',
          'placeholder:text-[var(--ui-text-faint)]',
        )}
        aria-label="Decision reason"
      />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending !== null || !hasReason}
          onClick={() => submit(rewardAction)}
          className="ui-button ui-button-secondary ui-focus-ring"
        >
          {rewardAction === 'block'
            ? <Ban className="h-3.5 w-3.5" aria-hidden />
            : <Undo2 className="h-3.5 w-3.5" aria-hidden />}
          {pending === rewardAction
            ? PENDING_LABELS[rewardAction]
            : rewardAction === 'block' ? 'Block rewards' : 'Unblock rewards'}
        </button>

        {linkAction ? (
          <button
            type="button"
            disabled={pending !== null || !hasReason}
            onClick={() => submit(linkAction)}
            className="ui-button ui-button-secondary ui-focus-ring"
            title={linkAction === 'disable_link'
              ? 'Stops new invites and holds the rewards of every referral this link made'
              : 'Takes new invites again; held rewards are paid within the hour'}
          >
            {linkAction === 'disable_link'
              ? <Link2Off className="h-3.5 w-3.5" aria-hidden />
              : <Link2 className="h-3.5 w-3.5" aria-hidden />}
            {pending === linkAction
              ? PENDING_LABELS[linkAction]
              : linkAction === 'disable_link' ? 'Switch link off' : 'Switch link on'}
          </button>
        ) : null}
      </div>

      {error ? <Text as="p" variant="caption" className="text-[var(--ui-danger)]">{error}</Text> : null}
    </div>
  );
}
