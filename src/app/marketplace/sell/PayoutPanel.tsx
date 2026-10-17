'use client';

import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, CircleAlert, Loader2, RefreshCw, Wallet } from 'lucide-react';

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

export default function PayoutPanel() {
  const [state, setState] = useState<PayoutState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [method, setMethod] = useState<PayoutMethod>('upi');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A request the server accepted whose follow-up read failed. The balance on
  // screen is the one from before the request, so the form stays away (a
  // second click would only meet the one-open-request 409) until a read shows
  // the pending payout.
  const [needsRefresh, setNeedsRefresh] = useState(false);

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

  const retryLoad = () => {
    setError(null);
    setIsLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
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
      await refreshAfterRequest();
    }
    setIsSubmitting(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-white/8 bg-zinc-900/40 px-4 py-6 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading your balance...
      </div>
    );
  }

  if (!state) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-400/20 bg-red-500/5 px-4 py-4 text-sm text-red-200"
      >
        <span>{error ?? 'Failed to load your payout balance.'}</span>
        <button
          type="button"
          onClick={retryLoad}
          className="inline-flex items-center gap-2 rounded-full border border-red-300/25 bg-red-500/10 px-3.5 py-1.5 text-xs font-semibold text-red-100 transition hover:bg-red-500/20"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Retry
        </button>
      </div>
    );
  }

  const selectedMethod = PAYOUT_METHODS.find((option) => option.value === method) ?? PAYOUT_METHODS[0];

  return (
    <section className="rounded-3xl border border-white/8 bg-zinc-900/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
            <Wallet className="h-3.5 w-3.5 text-emerald-300" />
            Payout balance
          </div>
          <div className="mt-2 text-3xl font-semibold text-white">{state.availableUsd}</div>
          <p className="mt-1 text-xs text-zinc-500">
            You keep 85% of every paid unlock. Payouts start at {state.minimumUsd} and are paid in INR to a
            UPI ID or an Indian bank account within 14 days of your request.
          </p>
        </div>
      </div>

      {state.pendingRequest ? (
        <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/5 px-4 py-3 text-sm text-emerald-100">
          <div className="font-semibold">
            {state.pendingRequest.amountUsd} payout in progress
          </div>
          <p className="mt-1 text-xs text-emerald-200/80">
            Requested {formatDate(state.pendingRequest.requestedAt)} via {formatPayoutMethod(state.pendingRequest.payoutMethod)}.
            We will update this once it is sent.
          </p>
        </div>
      ) : needsRefresh ? null : state.canRequest ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {PAYOUT_METHODS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMethod(option.value)}
                className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
                  method === option.value
                    ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-200'
                    : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {option.label}
              </button>
            ))}
            {COMING_SOON_PAYOUT_METHODS.map((label) => (
              <button
                key={label}
                type="button"
                disabled
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-white/10 px-3.5 py-1.5 text-xs font-semibold text-zinc-500 disabled:cursor-not-allowed"
              >
                {label}
                {/* The space keeps the button's name "PayPal Coming soon"; flex layout drops it. */}
                {' '}
                <span className="rounded-full bg-white/[0.06] px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-400">
                  Coming soon
                </span>
              </button>
            ))}
          </div>

          <label className="block">
            <span className="sr-only">Payout details</span>
            <input
              type="text"
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              maxLength={PAYOUT_DETAILS_MAX_LENGTH}
              placeholder={selectedMethod.placeholder}
              className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-white outline-none focus:border-emerald-300/40"
            />
          </label>
          <p className="text-[11px] leading-4 text-zinc-500">
            Never paste a full account number here. Send a UPI ID, or the account name with the last
            four digits and a contact we can reach you on.
          </p>

          <button
            type="button"
            onClick={submit}
            disabled={isSubmitting || details.trim().length < 3}
            className="inline-flex items-center gap-2 rounded-full bg-emerald-300 px-5 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-200 disabled:opacity-50"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Withdraw {state.availableUsd}
          </button>
        </div>
      ) : (
        <p className="mt-4 rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3 text-xs leading-5 text-zinc-400">
          You can withdraw once your balance reaches {state.minimumUsd}. Earnings from every unlock
          land here automatically.
        </p>
      )}

      {error ? (
        <p className="mt-3 flex items-start gap-2 text-xs text-red-300">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {error}
        </p>
      ) : null}

      {notice ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-emerald-300">
          <p className="flex items-start gap-2">
            <BadgeCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {notice}
          </p>
          {needsRefresh ? (
            <button
              type="button"
              onClick={() => void refreshAfterRequest()}
              disabled={isRefreshing}
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/25 bg-emerald-300/5 px-3 py-1 font-semibold text-emerald-200 transition hover:bg-emerald-300/10 disabled:opacity-50"
            >
              {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
              Refresh to see the update
            </button>
          ) : null}
        </div>
      ) : null}

      {state.history.length > 0 ? (
        <ul className="mt-5 space-y-2 border-t border-white/8 pt-4">
          {state.history.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <span className="text-zinc-300">
                {entry.amountUsd} · {entry.status === 'paid' ? 'Paid' : entry.status === 'rejected' ? 'Rejected' : 'In progress'}
              </span>
              <span className="text-zinc-600">
                {formatDate(entry.resolvedAt ?? entry.requestedAt)}
              </span>
              {entry.status === 'rejected' && entry.resolutionNote ? (
                <span className="w-full text-[11px] text-amber-200/80">{entry.resolutionNote}</span>
              ) : null}
              {entry.status === 'paid' && entry.externalReference ? (
                <span className="w-full text-[11px] text-zinc-600">Ref {entry.externalReference}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
