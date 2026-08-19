'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ShieldBan, Undo2 } from 'lucide-react';
import clsx from 'clsx';

/**
 * Per-generation remove/restore, shown inline in a row of the creations table.
 *
 * A rationale is required before either button enables, matching every other
 * moderation surface: the audit row is the only durable explanation, and a
 * removal with no reason cannot answer an appeal.
 */
export function GenerationModerationControls({
  generationId,
  isRemoved,
}: {
  generationId: string;
  isRemoved: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const action = isRemoved ? 'restore' : 'remove';

  async function submit() {
    if (reason.trim().length < 3 || pending) return;
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/moderation/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationId, action, reason, idempotencyKey }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(typeof payload?.error === 'string' ? payload.error : 'Action failed.');
        return;
      }

      setReason('');
      setOpen(false);
      setIdempotencyKey(crypto.randomUUID());
      router.refresh();
    } catch {
      setError('Action failed. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={clsx(
          'ui-button ui-focus-ring text-xs',
          isRemoved ? 'ui-button-secondary' : 'bg-[rgba(255,124,139,0.14)] text-[var(--ui-accent-danger)]',
        )}
      >
        {isRemoved
          ? <><Undo2 className="h-3.5 w-3.5" aria-hidden />Restore</>
          : <><ShieldBan className="h-3.5 w-3.5" aria-hidden />Remove</>}
      </button>
    );
  }

  return (
    <div className="flex min-w-[220px] flex-col gap-1.5">
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={2}
        maxLength={1000}
        aria-label={isRemoved ? 'Reason for restoring' : 'Reason for removing'}
        placeholder={isRemoved ? 'Why this is being restored' : 'Policy section and evidence'}
        className="ui-focus-ring w-full rounded-lg border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-2 py-1.5 text-xs text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)]"
      />
      {error ? (
        <p role="alert" className="text-xs font-semibold text-[var(--ui-accent-danger)]">{error}</p>
      ) : null}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={submit}
          disabled={reason.trim().length < 3 || pending}
          className={clsx(
            'ui-button ui-focus-ring text-xs disabled:opacity-50',
            isRemoved ? 'ui-button-primary' : 'bg-[rgba(255,124,139,0.14)] text-[var(--ui-accent-danger)]',
          )}
        >
          {pending ? 'Working…' : (isRemoved ? 'Confirm restore' : 'Confirm removal')}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null); }}
          className="ui-button ui-button-ghost ui-focus-ring text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
