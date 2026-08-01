'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BadgeCheck, Ban } from 'lucide-react';

import { Text } from '@/app/components/DesignSystem';

type PayoutAction = 'mark_paid' | 'reject';

export function PayoutActions({ requestId, amountUsd }: { requestId: string; amountUsd: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [pending, setPending] = useState<PayoutAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (action: PayoutAction) => {
    setPending(action);
    setError(null);

    try {
      const response = await fetch('/api/admin/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          action,
          note: note.trim() || null,
          externalReference: reference.trim() || null,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'Failed to settle the payout.');
        return;
      }

      router.refresh();
    } catch {
      setError('Failed to settle the payout.');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          type="text"
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          placeholder="Bank reference / UTR"
          className="ui-input"
          aria-label="Payout reference"
        />
        <input
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Note (required to reject)"
          className="ui-input"
          aria-label="Payout note"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => submit('mark_paid')}
          className="ui-button ui-button-primary ui-focus-ring"
        >
          <BadgeCheck className="h-3.5 w-3.5" />
          {pending === 'mark_paid' ? 'Marking...' : `Mark ${amountUsd} paid`}
        </button>
        <button
          type="button"
          disabled={pending !== null || !note.trim()}
          onClick={() => submit('reject')}
          className="ui-button ui-button-secondary ui-focus-ring"
        >
          <Ban className="h-3.5 w-3.5" />
          {pending === 'reject' ? 'Rejecting...' : 'Reject'}
        </button>
      </div>

      {error ? <Text as="p" variant="caption" className="text-[var(--ui-danger)]">{error}</Text> : null}
    </div>
  );
}
