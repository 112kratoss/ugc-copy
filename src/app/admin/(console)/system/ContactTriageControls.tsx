'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import clsx from 'clsx';

/**
 * Marks a contact enquiry dealt with, or reopens one.
 *
 * The note is optional: unlike a moderation decision, marking an enquiry
 * answered is not an action against anyone, and forcing a justification for
 * routine triage would just train operators to type "done".
 */
export function ContactTriageControls({
  messageId,
  isHandled,
}: {
  messageId: string;
  isHandled: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(handled: boolean) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, handled, note: handled ? note : null }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(typeof payload?.error === 'string' ? payload.error : 'Action failed.');
        return;
      }

      setNote('');
      router.refresh();
    } catch {
      setError('Action failed. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  if (isHandled) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={pending}
          className="ui-button ui-button-secondary ui-focus-ring disabled:opacity-50"
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          {pending ? 'Reopening…' : 'Reopen'}
        </button>
        {error ? (
          <p role="alert" className="text-sm font-semibold text-[var(--ui-accent-danger)]">{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <label className="min-w-[220px] flex-1">
        <span className="sr-only">What was done (optional)</span>
        <input
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={1000}
          placeholder="What was done (optional)"
          className={clsx(
            'ui-focus-ring w-full rounded-xl border border-[var(--ui-border-default)]',
            'bg-[var(--ui-surface-inset)] px-3 py-2 text-sm text-[var(--ui-text-primary)]',
            'placeholder:text-[var(--ui-text-faint)]',
          )}
        />
      </label>
      <button
        type="button"
        onClick={() => submit(true)}
        disabled={pending}
        className="ui-button ui-button-primary ui-focus-ring disabled:opacity-50"
      >
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        {pending ? 'Marking…' : 'Mark handled'}
      </button>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-[var(--ui-accent-danger)]">{error}</p>
      ) : null}
    </div>
  );
}
