'use client';

import { useRouter } from 'next/navigation';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { Coins } from 'lucide-react';
import clsx from 'clsx';

import { Surface, Text } from '@/app/components/DesignSystem';

type Intent = 'goodwill' | 'refund' | 'clawback';

const INTENTS: Array<{ value: Intent; label: string; effect: string }> = [
  { value: 'goodwill', label: 'Goodwill', effect: 'Adds promotional credits' },
  { value: 'refund', label: 'Refund', effect: 'Adds purchased credits' },
  { value: 'clawback', label: 'Clawback', effect: 'Removes promotional credits' },
];

const MAX_AMOUNT = 10_000;

const INPUT_CLASSES = 'ui-focus-ring w-full rounded-xl border border-[var(--ui-border-default)] '
  + 'bg-[var(--ui-surface-inset)] px-3 py-2.5 text-sm text-[var(--ui-text-primary)] '
  + 'placeholder:text-[var(--ui-text-faint)]';

export function CreditAdjustmentForm({ userId }: { userId: string }) {
  const router = useRouter();
  const fieldId = useId();
  const [intent, setIntent] = useState<Intent>('goodwill');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Regenerated only when the inputs change, so a double-click sends the same
  // key twice and the database collapses it to a single adjustment, while a
  // genuinely new adjustment gets a fresh key.
  const idempotencyKey = useMemo(
    () => `${userId}:${intent}:${amount}:${reason}`,
    [userId, intent, amount, reason],
  );

  const parsedAmount = Number(amount);
  const amountValid = Number.isInteger(parsedAmount) && parsedAmount > 0 && parsedAmount <= MAX_AMOUNT;
  const reasonValid = reason.trim().length >= 3;
  const canSubmit = amountValid && reasonValid && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch('/api/admin/users/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, intent, amount: parsedAmount, reason, idempotencyKey }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(typeof payload?.error === 'string' ? payload.error : 'Adjustment failed.');
        return;
      }

      setSuccess(
        payload?.status === 'already_applied'
          ? 'Already applied — this exact adjustment was recorded previously.'
          : `Applied. Balances now ${payload?.credits ?? '—'} credits, ${payload?.promotionalCredits ?? '—'} promotional.`,
      );
      setAmount('');
      setReason('');
      router.refresh();
    } catch {
      setError('Adjustment failed. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const selected = INTENTS.find((option) => option.value === intent);

  return (
    <Surface variant="card" padding="md">
      <div className="flex items-center gap-2">
        <Coins className="h-4 w-4 text-[var(--ui-text-faint)]" aria-hidden />
        <Text as="h3" variant="label">Adjust credits</Text>
      </div>
      <Text variant="caption" className="mt-1">
        Every adjustment is recorded against your reviewer id with its reason.
      </Text>

      <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
        <fieldset>
          <legend className="sr-only">Adjustment type</legend>
          <div className="flex flex-wrap gap-1.5">
            {INTENTS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={intent === option.value}
                onClick={() => setIntent(option.value)}
                className={clsx(
                  'ui-button ui-focus-ring',
                  intent === option.value ? 'ui-button-primary' : 'ui-button-secondary',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Text variant="caption" className="mt-2">{selected?.effect}</Text>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${fieldId}-amount`}>
              <Text as="span" variant="label">Amount</Text>
            </label>
            <input
              id={`${fieldId}-amount`}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_AMOUNT}
              step={1}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="500"
              className={INPUT_CLASSES}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${fieldId}-reason`}>
              <Text as="span" variant="label">Reason</Text>
            </label>
            <input
              id={`${fieldId}-reason`}
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
              placeholder="Ticket reference and what went wrong"
              className={INPUT_CLASSES}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className="ui-button ui-button-primary ui-focus-ring disabled:opacity-50"
          >
            {submitting ? 'Applying…' : 'Apply adjustment'}
          </button>
          {!amountValid && amount ? (
            <Text variant="caption">Whole number between 1 and {MAX_AMOUNT.toLocaleString()}</Text>
          ) : null}
          {amountValid && !reasonValid ? <Text variant="caption">A reason is required</Text> : null}
        </div>

        {error ? (
          <p role="alert" className="text-sm font-semibold text-[var(--ui-accent-danger)]">{error}</p>
        ) : null}
        {success ? (
          <p role="status" className="text-sm font-semibold text-[#5ee9a4]">{success}</p>
        ) : null}
      </form>
    </Surface>
  );
}
