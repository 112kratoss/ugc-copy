'use client';

import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, CircleAlert, Loader2, Wallet } from 'lucide-react';

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

const PAYOUT_METHODS = [
  { value: 'upi', label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'paypal', label: 'PayPal' },
] as const;

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function PayoutPanel() {
  const [state, setState] = useState<PayoutState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [method, setMethod] = useState<string>('upi');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
  }, [load]);

  const submit = async () => {
    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      const headers = await authHeaders();
      const response = await fetch('/api/creator/payouts', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payoutMethod: method, payoutDetails: details.trim() }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'Failed to request a payout.');
        return;
      }

      setNotice('Payout requested. We will settle it and update this page.');
      setDetails('');
      setState(await load());
    } catch {
      setError('Failed to request a payout.');
    } finally {
      setIsSubmitting(false);
    }
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
      <div className="rounded-2xl border border-red-400/20 bg-red-500/5 px-4 py-4 text-sm text-red-200">
        {error ?? 'Failed to load your payout balance.'}
      </div>
    );
  }

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
            You keep 85% of every unlock. Payouts start at {state.minimumUsd}.
          </p>
        </div>
      </div>

      {state.pendingRequest ? (
        <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/5 px-4 py-3 text-sm text-emerald-100">
          <div className="font-semibold">
            {state.pendingRequest.amountUsd} payout in progress
          </div>
          <p className="mt-1 text-xs text-emerald-200/80">
            Requested {formatDate(state.pendingRequest.requestedAt)} via {state.pendingRequest.payoutMethod}.
            We will update this once it is sent.
          </p>
        </div>
      ) : state.canRequest ? (
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
          </div>

          <label className="block">
            <span className="sr-only">Payout details</span>
            <input
              type="text"
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              placeholder={method === 'upi' ? 'your-name@bank' : 'Account name and last 4 digits, plus a contact'}
              className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-white outline-none focus:border-emerald-300/40"
            />
          </label>
          <p className="text-[11px] leading-4 text-zinc-500">
            Never paste a full account number here. Send a UPI id, or the account name with the last
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
        <p className="mt-3 flex items-start gap-2 text-xs text-emerald-300">
          <BadgeCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {notice}
        </p>
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
