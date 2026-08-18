'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { ShieldBan, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';

import { Surface, Text } from '@/app/components/DesignSystem';

/**
 * Mirrors ADMIN_SANCTION_DURATIONS on the server. Fixed choices rather than a
 * free-text field: an operator typing hours is one keystroke away from a
 * 10,000-hour "24-hour" suspension, and the mistake is invisible afterwards.
 */
const DURATIONS: Array<{ value: string; hours: number | null; label: string }> = [
  { value: '24', hours: 24, label: '24 hours' },
  { value: '168', hours: 24 * 7, label: '7 days' },
  { value: '720', hours: 24 * 30, label: '30 days' },
  { value: 'indefinite', hours: null, label: 'Indefinite' },
];

const INPUT_CLASSES = 'ui-focus-ring w-full rounded-xl border border-[var(--ui-border-default)] '
  + 'bg-[var(--ui-surface-inset)] px-3 py-2.5 text-sm text-[var(--ui-text-primary)] '
  + 'placeholder:text-[var(--ui-text-faint)]';

export function UserSanctionForm({
  userId,
  isSuspended,
  bannedUntil,
}: {
  userId: string;
  isSuspended: boolean;
  bannedUntil: string | null;
}) {
  const router = useRouter();
  const fieldId = useId();
  const [duration, setDuration] = useState('24');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  /**
   * Regenerated only after a submission settles, so a double-click collapses to
   * one sanction server-side while a genuine second decision gets its own key.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const action = isSuspended ? 'reinstate' : 'suspend';
  const canSubmit = reason.trim().length >= 3 && !pending;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setPending(true);
    setError(null);
    setResult(null);

    const selected = DURATIONS.find((option) => option.value === duration);

    try {
      const response = await fetch('/api/admin/users/sanctions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          action,
          reason,
          durationHours: action === 'suspend' ? selected?.hours ?? null : null,
          idempotencyKey,
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(typeof payload?.error === 'string' ? payload.error : 'Sanction failed.');
        return;
      }

      setResult(
        payload?.status === 'already_applied'
          ? 'Already applied — this decision was recorded earlier.'
          : action === 'suspend'
            ? 'Account suspended. The user can no longer sign in.'
            : 'Account reinstated. The user can sign in again.',
      );
      setReason('');
      setIdempotencyKey(crypto.randomUUID());
      router.refresh();
    } catch {
      setError('Sanction failed. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Surface variant="card" padding="md">
      <div className="flex items-center gap-2">
        {isSuspended
          ? <ShieldBan className="h-5 w-5 text-[var(--ui-accent-danger)]" aria-hidden />
          : <ShieldCheck className="h-5 w-5 text-[var(--ui-text-faint)]" aria-hidden />}
        <Text as="h2" variant="label">Account access</Text>
      </div>

      {isSuspended ? (
        <div className="mt-3 rounded-xl border border-[var(--ui-accent-danger)] bg-[rgba(255,124,139,0.08)] px-3 py-2.5">
          <Text variant="bodySm" className="font-semibold text-[var(--ui-accent-danger)]">
            Suspended — this account cannot sign in.
          </Text>
          {bannedUntil ? (
            <Text variant="caption" className="mt-0.5 block">
              Until {bannedUntil}
            </Text>
          ) : null}
        </div>
      ) : (
        <Text variant="bodySm" className="mt-2">
          Active. Suspending blocks sign-in immediately and revokes the account&rsquo;s sessions.
        </Text>
      )}

      {/*
        Stated explicitly because the two are easy to conflate, and an operator
        who assumed a suspension also pulled the content would leave violating
        posts public while believing they had handled the case.
      */}
      <Text variant="caption" className="mt-2 block">
        This controls sign-in only. It does not hide the user&rsquo;s posts — take those down
        individually so each removal is audited on its own.
      </Text>

      <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
        {!isSuspended ? (
          <div>
            <label htmlFor={`${fieldId}-duration`}>
              <Text as="span" variant="caption" className="uppercase tracking-[0.08em]">Duration</Text>
            </label>
            <select
              id={`${fieldId}-duration`}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
              className={clsx(INPUT_CLASSES, 'mt-1.5')}
            >
              {DURATIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <label htmlFor={`${fieldId}-reason`}>
            <Text as="span" variant="caption" className="uppercase tracking-[0.08em]">
              Reason (recorded in the audit log)
            </Text>
          </label>
          <textarea
            id={`${fieldId}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            required
            minLength={3}
            maxLength={1000}
            placeholder={isSuspended
              ? 'Why the account is being restored — appeal outcome, or a mistaken suspension'
              : 'Policy section and the evidence behind this decision'}
            className={clsx(INPUT_CLASSES, 'mt-1.5')}
          />
        </div>

        {/* Plain <p> so the live-region role lands on the element itself, matching
            CreditAdjustmentForm and ModerationActions. */}
        {error ? (
          <p role="alert" className="text-sm font-semibold text-[var(--ui-accent-danger)]">{error}</p>
        ) : null}
        {result ? (
          <p role="status" className="text-sm font-semibold text-[#5ee9a4]">{result}</p>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          className={clsx(
            'ui-button ui-focus-ring self-start disabled:opacity-50',
            isSuspended
              ? 'ui-button-secondary'
              : 'bg-[rgba(255,124,139,0.14)] text-[var(--ui-accent-danger)]',
          )}
        >
          {pending
            ? (isSuspended ? 'Reinstating…' : 'Suspending…')
            : (isSuspended ? 'Reinstate account' : 'Suspend account')}
        </button>
      </form>
    </Surface>
  );
}
