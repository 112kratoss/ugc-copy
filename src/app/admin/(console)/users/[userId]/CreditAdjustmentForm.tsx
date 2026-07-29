'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { Coins } from 'lucide-react';
import clsx from 'clsx';

import { Surface, Text } from '@/app/components/DesignSystem';

type Intent = 'goodwill' | 'refund' | 'clawback';

/**
 * Labels state the balance effect literally.
 *
 * "Refund" alone was misleading: this restores credits inside the product and
 * moves no money. A real payment reversal belongs to Razorpay plus
 * `reconcile_credit_purchase_adjustment`, and an operator who conflated the two
 * would tell a customer their money was on its way when it was not.
 */
const INTENTS: Array<{ value: Intent; label: string; effect: string; caution?: string }> = [
  {
    value: 'goodwill',
    label: 'Goodwill grant',
    effect: 'Adds promotional credits',
  },
  {
    value: 'refund',
    label: 'Restore purchased credits',
    effect: 'Adds purchased credits',
    caution: 'This does NOT reverse a payment. Refund the money in Razorpay separately.',
  },
  {
    value: 'clawback',
    label: 'Clawback',
    effect: 'Removes promotional credits',
    caution: 'Can drive the balance negative — by design, so already-spent value is not silently forgiven.',
  },
];

const MAX_AMOUNT = 10_000;

/** Mirrors planAdminCreditAdjustment so the preview matches what the server does. */
function previewDeltas(intent: Intent, amount: number) {
  switch (intent) {
    case 'goodwill':
      return { creditsDelta: 0, promotionalCreditsDelta: amount };
    case 'refund':
      return { creditsDelta: amount, promotionalCreditsDelta: 0 };
    case 'clawback':
      return { creditsDelta: 0, promotionalCreditsDelta: -amount };
  }
}

const INPUT_CLASSES = 'ui-focus-ring w-full rounded-xl border border-[var(--ui-border-default)] '
  + 'bg-[var(--ui-surface-inset)] px-3 py-2.5 text-sm text-[var(--ui-text-primary)] '
  + 'placeholder:text-[var(--ui-text-faint)]';

export function CreditAdjustmentForm({
  userId,
  credits,
  promotionalCredits,
}: {
  userId: string;
  credits: number;
  promotionalCredits: number;
}) {
  const router = useRouter();
  const fieldId = useId();
  const [intent, setIntent] = useState<Intent>('goodwill');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  /**
   * A random id per submission attempt, NOT derived from the form contents.
   *
   * Deriving it from user + intent + amount + reason looked idempotent but was
   * a correctness bug: two legitimately separate adjustments with identical
   * fields — the same goodwill grant for two different incidents — collided,
   * and the second silently returned `already_applied` without moving the
   * balance. The id is held across retries of an uncertain submit (network
   * error, timeout) so a retry cannot double-credit, and is regenerated once an
   * attempt is known to have landed.
   */
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());

  const parsedAmount = Number(amount);
  const amountValid = Number.isInteger(parsedAmount) && parsedAmount > 0 && parsedAmount <= MAX_AMOUNT;
  const reasonValid = reason.trim().length >= 3;
  const canSubmit = amountValid && reasonValid && !submitting;

  // Any edit above resets `confirming`, so the previewed numbers always match
  // the values that will be submitted.
  const deltas = previewDeltas(intent, amountValid ? parsedAmount : 0);
  const nextCredits = credits + deltas.creditsDelta;
  const nextPromotionalCredits = promotionalCredits + deltas.promotionalCreditsDelta;
  const goesNegative = nextCredits < 0 || nextPromotionalCredits < 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    // Two-stage: the first submit only reveals the resulting balances. Nothing
    // reaches the server until the operator confirms what they just read.
    if (!confirming) {
      setConfirming(true);
      setError(null);
      setSuccess(null);
      return;
    }

    setConfirming(false);
    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch('/api/admin/users/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          intent,
          amount: parsedAmount,
          reason,
          idempotencyKey: submissionId,
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        // The server answered, so this attempt definitively did not apply.
        // A fresh id lets the operator correct the input and try again.
        setSubmissionId(crypto.randomUUID());
        setError(typeof payload?.error === 'string' ? payload.error : 'Adjustment failed.');
        return;
      }

      setSuccess(
        payload?.status === 'already_applied'
          ? 'Already applied — this submission had already been recorded, so no second adjustment was made.'
          : `Applied. Balances now ${payload?.credits ?? '—'} credits, ${payload?.promotionalCredits ?? '—'} promotional.`,
      );
      setSubmissionId(crypto.randomUUID());
      setAmount('');
      setReason('');
      router.refresh();
    } catch {
      // Deliberately keeps the current submissionId: the request may have
      // reached the database before the connection dropped, so retrying with
      // the same id is what prevents a double credit.
      setError('Adjustment failed — it may or may not have applied. Retrying is safe: this submission can only be recorded once. Reload to confirm the balance.');
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
                onClick={() => { setIntent(option.value); setConfirming(false); }}
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
          {selected?.caution ? (
            <Text variant="caption" className="mt-1 text-[#ffc46b]">{selected.caution}</Text>
          ) : null}
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
              onChange={(event) => { setAmount(event.target.value); setConfirming(false); }}
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
              onChange={(event) => { setReason(event.target.value); setConfirming(false); }}
              maxLength={1000}
              placeholder="Ticket reference and what went wrong"
              className={INPUT_CLASSES}
            />
          </div>
        </div>

        {confirming ? (
          <div
            role="alert"
            className="rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3"
          >
            <Text as="p" variant="label">Confirm this adjustment</Text>
            <dl className="mt-2 flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <dt><Text as="span" variant="caption">Purchased credits</Text></dt>
                <dd className="font-mono text-[13px] text-[var(--ui-text-secondary)]">
                  {credits.toLocaleString()} →{' '}
                  <span className={nextCredits < 0 ? 'font-bold text-[var(--ui-accent-danger)]' : 'font-bold text-[var(--ui-text-primary)]'}>
                    {nextCredits.toLocaleString()}
                  </span>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt><Text as="span" variant="caption">Promotional credits</Text></dt>
                <dd className="font-mono text-[13px] text-[var(--ui-text-secondary)]">
                  {promotionalCredits.toLocaleString()} →{' '}
                  <span className={nextPromotionalCredits < 0 ? 'font-bold text-[var(--ui-accent-danger)]' : 'font-bold text-[var(--ui-text-primary)]'}>
                    {nextPromotionalCredits.toLocaleString()}
                  </span>
                </dd>
              </div>
            </dl>

            {goesNegative ? (
              <Text variant="caption" className="mt-2 text-[var(--ui-accent-danger)]">
                This leaves the account in debt. That is allowed — spent value is not forgiven —
                but confirm it is what you intend.
              </Text>
            ) : null}
            {intent === 'refund' ? (
              <Text variant="caption" className="mt-2 text-[#ffc46b]">
                No money moves. Issue the payment refund in Razorpay separately.
              </Text>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className={clsx(
              'ui-button ui-focus-ring disabled:opacity-50',
              confirming ? 'ui-button-primary' : 'ui-button-secondary',
            )}
          >
            {submitting
              ? 'Applying…'
              : confirming
                ? `Confirm ${selected?.label.toLowerCase()}`
                : 'Review adjustment'}
          </button>

          {confirming && !submitting ? (
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="ui-button ui-button-ghost ui-focus-ring"
            >
              Cancel
            </button>
          ) : null}

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
