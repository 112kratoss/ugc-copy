'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useId, useRef } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import clsx from 'clsx';

import { getAccentClasses } from '@/components/DesignSystem';
import { CREDIT_CHECKOUT_STATUS_COPY, useCreditPackCheckout } from '@/components/useCreditPackCheckout';
import { useInertPageBeneath } from '@/components/useInertPageBeneath';
import { useModalQuestion } from '@/components/useModalQuestion';
import { packCoveringNeed, type CreditTopUpNeed } from '@/lib/credit-top-up';
import { PRICING_PLANS } from '@/lib/pricing';

const FOCUSABLE = 'a[href], button:not([disabled])';

const priceWords = (priceInr: number) => `₹${priceInr.toLocaleString('en-IN')}`;

/**
 * Razorpay's checkout, which checkout.js draws in a container of its own under <body> and keeps
 * there between opens: made inert with the page beneath the sheet, a second sheet's checkout
 * would take no press or key.
 */
const isRazorpayCheckout = (element: HTMLElement) => (
  Array.from(element.classList).some((name) => name.startsWith('razorpay'))
);

/**
 * The packs the pricing page sells (`contracts/credit-packs-v1.json`), sold through the same
 * checkout (`useCreditPackCheckout`): the run's cost and the balance over them, the smallest
 * pack that covers the run marked, and what the checkout says under them. The page beneath
 * keeps everything set up, and a settled payment brings the balance up there, so Generate is
 * back once the sheet goes.
 */
export function CreditTopUpPanel({ need, pricingHref, onClose }: { need: CreditTopUpNeed; pricingHref: string; onClose: () => void }) {
  const router = useRouter();
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstPackRef = useRef<HTMLButtonElement>(null);
  const { buy, loadingPlan, status } = useCreditPackCheckout({
    onSignedOut: () => router.push(`/login?returnUrl=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`),
  });
  // From the sheet's word that the money is taken, the checkout must be left to finish: nothing
  // closes the sheet or leads away from it until it says how the payment went.
  const confirming = status?.kind === 'confirming';
  // A payment made: the balance the sheet was opened with is no longer the account's.
  const paying = status !== null && status.kind !== 'failed';
  const covering = packCoveringNeed(PRICING_PLANS, need);

  // First: the focus useModalQuestion gives back as the sheet goes does nothing
  // while the page beneath is still inert, and effects are undone in order.
  useInertPageBeneath(overlayRef, { spare: isRazorpayCheckout });
  useModalQuestion({
    questionId: 1,
    dialogRef: panelRef,
    initialFocus: () => firstPackRef.current,
    focusables: () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    onCancel: () => {
      if (!confirming) onClose();
    },
  });

  const body = need && need.balance < need.cost && !paying
    ? `This run costs ${need.cost.toLocaleString('en-IN')} credits and you have ${need.balance.toLocaleString('en-IN')}. Everything you set up stays on this page.`
    : 'Everything you set up stays on this page.';

  return (
    <div
      ref={overlayRef}
      className="ui-confirm-backdrop"
      onClick={(event) => {
        // Not the second click of a double-click on Top Up: its first brought the sheet up under the pointer.
        if (event.target === event.currentTarget && event.detail < 2 && !confirming) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="ui-confirm-dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="ui-confirm-title">Top up credits</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={confirming}
            aria-label="Close"
            title="Close"
            className="ui-icon-button ui-focus-ring -mr-2 -mt-2 shrink-0 disabled:opacity-50"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <p id={bodyId} className="ui-confirm-message">{body}</p>

        <ul className="mt-5 space-y-2" aria-label="Credit packs">
          {PRICING_PLANS.map((plan, index) => {
            const covers = covering?.id === plan.id;
            return (
              <li key={plan.id}>
                <button
                  ref={index === 0 ? firstPackRef : undefined}
                  type="button"
                  onClick={(event) => {
                    if (event.detail < 2) void buy(plan.id);
                  }}
                  disabled={loadingPlan !== null || confirming}
                  aria-label={`Buy ${plan.credits.toLocaleString('en-IN')} credits for ${priceWords(plan.priceInr)}${covers ? ', covers this run' : ''}`}
                  className={clsx(
                    'ui-focus-ring flex min-h-14 w-full items-center justify-between gap-3 rounded-ui-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    covers
                      ? 'border-[var(--ui-primary)]/60 bg-[var(--ui-primary)]/10 hover:border-[var(--ui-primary)]'
                      : 'border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] hover:border-[var(--ui-border-strong)] hover:bg-[var(--ui-surface-3)]'
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-bold text-[var(--ui-text-primary)]">{plan.credits.toLocaleString('en-IN')} credits</span>
                      {covers ? (
                        <span className="rounded-full bg-[var(--ui-primary)] px-2 py-0.5 text-xs font-bold text-[var(--ui-primary-on)]">Covers this run</span>
                      ) : plan.badge ? (
                        <span className="rounded-full border border-[var(--ui-border-default)] px-2 py-0.5 text-xs font-bold text-[var(--ui-text-secondary)]">{plan.badge}</span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-[var(--ui-text-muted)]">{plan.name}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-sm font-extrabold text-[var(--ui-text-primary)]">
                    {loadingPlan === plan.id ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
                    {priceWords(plan.priceInr)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {status ? (
          <p
            role={status.kind === 'failed' ? 'alert' : 'status'}
            className={clsx(
              'mt-4 flex items-start gap-2 text-sm leading-6',
              status.kind === 'failed' ? 'text-[var(--ui-accent-danger)]' : 'text-[var(--ui-text-secondary)]'
            )}
          >
            {status.kind === 'confirming' ? <Loader2 aria-hidden className="mt-1 h-4 w-4 shrink-0 animate-spin" /> : null}
            {status.kind === 'settled' ? <Check aria-hidden className={clsx('mt-1 h-4 w-4 shrink-0', getAccentClasses('workflow').mark)} /> : null}
            <span>{status.kind === 'failed' ? status.message : CREDIT_CHECKOUT_STATUS_COPY[status.kind]}</span>
          </p>
        ) : null}

        {status && status.kind !== 'failed' && status.kind !== 'confirming' ? (
          <button type="button" onClick={onClose} className="ui-button ui-button-primary ui-focus-ring mt-5 w-full">
            Back to your run
          </button>
        ) : (
          <p className="mt-5 text-xs leading-5 text-[var(--ui-text-muted)]">
            Paid in INR through Razorpay: cards, UPI, net banking and wallets.
            {confirming ? null : (
              <>
                {' '}
                <Link href={pricingHref} className="font-semibold text-[var(--ui-text-secondary)] underline-offset-2 hover:underline">
                  See every pack
                </Link>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
