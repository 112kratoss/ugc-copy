'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowDownToLine, BadgeCheck, CircleAlert, Loader2, RefreshCw, Wallet, X } from 'lucide-react';

import { Button, StatusCallout, Surface, Text, getAccentClasses } from '@/components/DesignSystem';
import { POST_RESOURCE_CREATOR_SHARE_PERCENT, POST_RESOURCE_TOKEN_SUBUNITS } from '@/lib/post-resource-commerce';
import { formatUsdCents } from '@/lib/post-resource-bundles';
import { supabase } from '@/lib/supabase';

type PayoutRequest = {
  id: string;
  amountUsd: string;
  status: 'requested' | 'paid' | 'rejected';
  payoutMethod: string;
  requestedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  externalReference: string | null;
};

type PayoutState = {
  availableUsd: string;
  minimumUsd: string;
  canRequest: boolean;
  pendingRequest: PayoutRequest | null;
  history: PayoutRequest[];
  // The balance in the wallet's token subunits, for the progress to the first
  // payout and the lifetime total. Read when the server sends them.
  availableTokenSubunits?: number;
  minimumTokenSubunits?: number;
  lifetimeEarnedTokenSubunits?: number;
};

// What a new payout can be sent by. Payouts go out in rupees over Indian rails,
// so the server takes UPI and Indian bank transfers only (decision 7,
// 2026-10-17) and answers a PayPal request 400 METHOD_UNAVAILABLE.
const PAYOUT_METHODS = [
  { value: 'upi', label: 'UPI', placeholder: 'your-name@bank' },
  { value: 'bank_transfer', label: 'Indian bank transfer', placeholder: 'Account name and last 4 digits, plus a contact' },
] as const;

// Shown so a seller abroad sees they are planned; never selectable or sent.
const COMING_SOON_PAYOUT_METHODS = ['PayPal', 'International transfer'] as const;

type PayoutMethod = (typeof PAYOUT_METHODS)[number]['value'];

// A request made before 2026-10-17 may name PayPal, and still reads by name.
const STORED_PAYOUT_METHOD_LABELS: Record<string, string> = { paypal: 'PayPal' };

// The server refuses details past this length (creator-payouts.ts) with a
// message that does not say the text was too long.
const PAYOUT_DETAILS_MAX_LENGTH = 500;

// The server keeps the method's id ("bank_transfer"); the seller reads its name.
function formatPayoutMethod(value: string): string {
  return PAYOUT_METHODS.find((option) => option.value === value)?.label
    ?? STORED_PAYOUT_METHOD_LABELS[value]
    ?? value.replace(/_/g, ' ');
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTokenSubunits(subunits: number): string {
  return formatUsdCents(Math.floor(subunits / POST_RESOURCE_TOKEN_SUBUNITS));
}

/** How far the balance is to the first payout, 0 to 1; null when the server sent no amounts. */
function progressToPayout(state: PayoutState): number | null {
  const { availableTokenSubunits: available, minimumTokenSubunits: minimum } = state;
  if (typeof available !== 'number' || typeof minimum !== 'number' || minimum <= 0) return null;
  return Math.min(1, Math.max(0, available / minimum));
}

/**
 * The Earnings tile of the overview: the balance, how far it is to the first
 * payout, a payout in progress, and Withdraw once it can be asked for. Withdraw
 * opens the request form as a row of its own under the tiles (`col-span-full`,
 * `order-last` in the overview's grid), where the methods and the details have
 * the page's width.
 */
export default function PayoutPanel({
  className,
  hideWhenEmpty = false,
}: {
  className?: string;
  /** Draw nothing, also while loading, unless there is a balance, a payout or a past one to show. */
  hideWhenEmpty?: boolean;
}) {
  const formId = useId();
  const withdrawButtonId = useId();
  const [state, setState] = useState<PayoutState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [method, setMethod] = useState<PayoutMethod>('upi');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A request the server accepted whose follow-up read failed. The balance on
  // screen is the one from before the request, so the form stays away (a
  // second click would only meet the one-open-request 409) until a read shows
  // the pending payout.
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const tileRef = useRef<HTMLDivElement | null>(null);
  const methodRef = useRef<HTMLInputElement | null>(null);

  const authHeaders = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token
      ? { Authorization: `Bearer ${session.access_token}` }
      : undefined;
  }, []);

  const load = useCallback(async () => {
    const headers = await authHeaders();
    const response = await fetch('/api/creator/payouts', { headers });
    if (!response.ok) {
      throw new Error('Failed to load your payout balance.');
    }
    return await response.json() as PayoutState;
  }, [authHeaders]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await load();
        if (!cancelled) setState(next);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load your payout balance.');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [load, loadAttempt]);

  // The form opens at the end of the overview, past the other tiles: the
  // focus goes to its chosen method, so the keyboard lands where it appeared.
  useEffect(() => {
    if (formOpen) methodRef.current?.focus();
  }, [formOpen]);

  const retryLoad = () => {
    setError(null);
    setIsLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };

  const closeForm = () => {
    // A request in flight answers in the form: closing it now would lose a
    // refusal or a failure along with it.
    if (isSubmitting) return;
    setFormOpen(false);
    setError(null);
    document.getElementById(withdrawButtonId)?.focus();
  };

  const refreshAfterRequest = async () => {
    setIsRefreshing(true);
    try {
      setState(await load());
      setNeedsRefresh(false);
    } catch {
      setNeedsRefresh(true);
    } finally {
      setIsRefreshing(false);
    }
  };

  const submit = async () => {
    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    let requested = false;
    try {
      const headers = await authHeaders();
      const response = await fetch('/api/creator/payouts', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payoutMethod: method, payoutDetails: details.trim() }),
      });

      if (response.ok) {
        requested = true;
      } else {
        const data = await response.json().catch(() => null) as { error?: unknown } | null;
        setError(typeof data?.error === 'string' ? data.error : 'Failed to request a payout.');
      }
    } catch {
      setError('Failed to request a payout.');
    }

    if (requested) {
      // The request stands whatever the read after it says: a failed read asks
      // for a refresh and never reads as a failed request.
      setNotice('Payout requested. We will settle it and update this page.');
      setDetails('');
      setFormOpen(false);
      await refreshAfterRequest();
      // The form and its button are gone: the focus goes to the tile, which
      // now says where the payout is.
      tileRef.current?.focus();
    }
    setIsSubmitting(false);
  };

  const heading = (
    <div className="flex items-center gap-2.5">
      <span className={clsx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-ui-md border', getAccentClasses('commerce').iconWrap)}>
        <Wallet className="h-4 w-4" aria-hidden="true" />
      </span>
      <Text as="h2" variant="label">Earnings</Text>
    </div>
  );

  if (isLoading) {
    if (hideWhenEmpty) return null;
    return (
      <Surface as="section" variant="card" padding="none" className={clsx('flex flex-col p-4 sm:p-5', className)}>
        {heading}
        <p className="mt-5 flex items-center gap-2 text-sm text-[var(--ui-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading your balance…
        </p>
      </Surface>
    );
  }

  if (!state) {
    // Beside no recipe the tile is extra, and a guest, whom the route refuses,
    // could never clear the error.
    if (hideWhenEmpty) return null;
    return (
      <Surface as="section" variant="card" padding="none" className={clsx('flex flex-col p-4 sm:p-5', className)}>
        {heading}
        <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--ui-accent-danger)]">
          <span>{error ?? 'Failed to load your payout balance.'}</span>
          <Button variant="secondary" icon={RefreshCw} iconPosition="start" onClick={retryLoad}>
            Retry
          </Button>
        </div>
      </Surface>
    );
  }

  if (
    hideWhenEmpty
    && !state.pendingRequest
    && state.history.length === 0
    && !state.lifetimeEarnedTokenSubunits
    && !state.availableTokenSubunits
    && !state.canRequest
  ) {
    return null;
  }

  const selectedMethod = PAYOUT_METHODS.find((option) => option.value === method) ?? PAYOUT_METHODS[0];
  const progress = progressToPayout(state);
  const lifetime = typeof state.lifetimeEarnedTokenSubunits === 'number' && state.lifetimeEarnedTokenSubunits > 0
    ? formatTokenSubunits(state.lifetimeEarnedTokenSubunits)
    : null;
  const canWithdraw = state.canRequest && !state.pendingRequest && !needsRefresh;
  // The newest request, when it was turned down and nothing has replaced it:
  // its alert sends the seller here for the reason, which a retry has to fix.
  const lastRequest = state.history[0];
  const rejection = !state.pendingRequest && lastRequest?.status === 'rejected' ? lastRequest : null;
  const caption = state.pendingRequest
    ? (lifetime ? `Lifetime ${lifetime}` : 'A payout is on its way')
    : canWithdraw
      ? (lifetime ? `Ready to withdraw · lifetime ${lifetime}` : 'Ready to withdraw')
      : lifetime
        ? `Lifetime ${lifetime}`
        : `You keep ${POST_RESOURCE_CREATOR_SHARE_PERCENT}% of every sale`;

  return (
    <>
      <Surface as="section" variant="card" padding="none" className={clsx('flex min-w-0 flex-col p-4 sm:p-5', className)}>
        {/* Focused once a request goes in: it is where the tile says what happened. */}
        <div ref={tileRef} tabIndex={-1} className="flex flex-1 flex-col outline-none">
          {heading}
          <Text as="p" variant="metric" className="mt-4 tabular-nums">{state.availableUsd}</Text>
          <Text variant="caption" className="mt-1">{caption}</Text>

          <div className="mt-auto pt-4">
            {rejection ? (
              <p className="mb-3 rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] px-3.5 py-3 text-xs leading-5 text-[var(--ui-text-secondary)]">
                <span className="font-semibold text-[var(--ui-accent-danger)]">Your {rejection.amountUsd} payout wasn’t sent.</span>
                {' '}
                {rejection.resolutionNote ?? 'The balance is back here to request again.'}
              </p>
            ) : null}
            {state.pendingRequest ? (
              <StatusCallout
                tone="success"
                title={`${state.pendingRequest.amountUsd} payout in progress`}
                body={`Requested ${formatDate(state.pendingRequest.requestedAt)} via ${formatPayoutMethod(state.pendingRequest.payoutMethod)}. It arrives within 14 days of the request.`}
              />
            ) : canWithdraw ? (
              <Button
                id={withdrawButtonId}
                variant="primary"
                icon={ArrowDownToLine}
                iconPosition="start"
                ariaExpanded={formOpen}
                ariaControls={formOpen ? formId : undefined}
                disabled={isSubmitting}
                onClick={() => (formOpen ? closeForm() : setFormOpen(true))}
                // The tile has a row of its own below 1280px.
                className="w-full sm:w-auto xl:w-full"
              >
                Withdraw {state.availableUsd}
              </Button>
            ) : needsRefresh ? null : (
              <div>
                {progress !== null ? (
                  <div
                    role="progressbar"
                    aria-label="Balance toward the payout minimum"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress * 100)}
                    aria-valuetext={`${state.availableUsd} of ${state.minimumUsd}`}
                    className="h-1.5 overflow-hidden rounded-full bg-[var(--ui-surface-inset)]"
                  >
                    <div className="h-full rounded-full bg-[var(--ui-accent-commerce)]" style={{ width: `${progress * 100}%` }} />
                  </div>
                ) : null}
                {/* Said under every balance, not only in the form: a seller
                    abroad learns here that payouts go to Indian rails. */}
                <p className="mt-2 text-xs font-semibold leading-5 text-[var(--ui-text-muted)]">
                  Withdraw from {state.minimumUsd}, paid in INR to UPI or an Indian bank.
                </p>
              </div>
            )}

            {notice ? (
              <div role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--ui-accent-workflow)]">
                <p className="flex items-start gap-2">
                  <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {notice}
                </p>
                {needsRefresh ? (
                  <Button
                    variant="secondary"
                    icon={RefreshCw}
                    iconPosition="start"
                    disabled={isRefreshing}
                    onClick={() => void refreshAfterRequest()}
                  >
                    {isRefreshing ? 'Refreshing…' : 'Refresh to see the update'}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {state.history.length > 0 ? (
              <details className="group mt-3 text-xs">
                <summary className="ui-focus-ring flex min-h-9 cursor-pointer list-none items-center rounded-full font-semibold text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] [&::-webkit-details-marker]:hidden">
                  Payout history ({state.history.length})
                </summary>
                <ul className="mt-1 space-y-2 border-t border-[var(--ui-border-subtle)] pt-2">
                  {state.history.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="text-[var(--ui-text-secondary)]">
                        {entry.amountUsd} · {entry.status === 'paid' ? 'Paid' : entry.status === 'rejected' ? 'Rejected' : 'In progress'}
                      </span>
                      <span className="text-[var(--ui-text-faint)]">{formatDate(entry.resolvedAt ?? entry.requestedAt)}</span>
                      {entry.status === 'rejected' && entry.resolutionNote ? (
                        <span className="w-full text-[var(--ui-accent-commerce)]">{entry.resolutionNote}</span>
                      ) : null}
                      {entry.status === 'paid' && entry.externalReference ? (
                        <span className="w-full text-[var(--ui-text-faint)]">Ref {entry.externalReference}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </div>
      </Surface>

      {canWithdraw && formOpen ? (
        <Surface as="section" variant="card" padding="lg" className="order-last col-span-full">
          <div
            id={formId}
            role="group"
            aria-labelledby={`${formId}-title`}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeForm();
            }}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-2xl">
                <Text as="h2" variant="cardTitle" id={`${formId}-title`}>Withdraw {state.availableUsd}</Text>
                <Text variant="bodySm" className="mt-1">
                  You keep {POST_RESOURCE_CREATOR_SHARE_PERCENT}% of every paid unlock. Payouts are paid in INR to a UPI ID
                  or an Indian bank account within 14 days of your request.
                </Text>
              </div>
              <Button variant="ghost" icon={X} iconPosition="start" disabled={isSubmitting} onClick={closeForm}>Cancel</Button>
            </div>

            <fieldset className="mt-5">
              <legend><Text as="span" variant="label">Pay me by</Text></legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {PAYOUT_METHODS.map((option) => (
                  <label
                    key={option.value}
                    className={clsx(
                      'inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3.5 text-xs font-semibold transition-colors duration-150',
                      'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ui-focus)]/55 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--ui-bg-app)]',
                      method === option.value
                        ? getAccentClasses('commerce').selected
                        : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]',
                    )}
                  >
                    <input
                      ref={method === option.value ? methodRef : undefined}
                      type="radio"
                      name={`${formId}-method`}
                      value={option.value}
                      checked={method === option.value}
                      onChange={() => setMethod(option.value)}
                      className="sr-only"
                    />
                    {option.label}
                  </label>
                ))}
                {COMING_SOON_PAYOUT_METHODS.map((label) => (
                  <label
                    key={label}
                    className="inline-flex min-h-9 cursor-not-allowed items-center gap-1.5 rounded-full border border-dashed border-[var(--ui-border-subtle)] px-3.5 text-xs font-semibold text-[var(--ui-text-faint)]"
                  >
                    <input type="radio" name={`${formId}-method`} disabled className="sr-only" />
                    {label}
                    {/* The space keeps the choice's name "PayPal Coming soon"; flex layout drops it. */}
                    {' '}
                    <span className="rounded-full bg-[var(--ui-surface-3)] px-1.5 py-px text-xs font-medium text-[var(--ui-text-muted)]">
                      Coming soon
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="mt-4 block max-w-xl">
              <Text as="span" variant="label">Payout details</Text>
              <input
                type="text"
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                maxLength={PAYOUT_DETAILS_MAX_LENGTH}
                placeholder={selectedMethod.placeholder}
                className={clsx(
                  'mt-2 min-h-12 w-full rounded-ui-lg border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 text-sm text-[var(--ui-text-primary)] outline-none placeholder:text-[var(--ui-text-faint)]',
                  getAccentClasses('commerce').fieldFocus,
                )}
              />
            </label>
            <Text variant="caption" className="mt-2 max-w-xl">
              Never paste a full account number here. Send a UPI ID, or the account name with the last
              four digits and a contact we can reach you on.
            </Text>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                onClick={() => void submit()}
                disabled={isSubmitting || details.trim().length < 3}
              >
                {isSubmitting ? 'Requesting…' : 'Request payout'}
              </Button>
              {error ? (
                <p role="alert" className="flex items-start gap-2 text-sm text-[var(--ui-accent-danger)]">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {error}
                </p>
              ) : null}
            </div>
          </div>
        </Surface>
      ) : null}
    </>
  );
}
