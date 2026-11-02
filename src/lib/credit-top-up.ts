/**
 * The top-up sheet a creator holds (`CreditTopUpHost` in `CreditTopUpSheet.tsx`), opened from
 * anything on the page that offers a top-up: the bar's Top Up Credits in Generate's place, the
 * line under Posted (the owner's ask, 2026-11-02: a short balance is sold credits on the page,
 * not sent to the pricing page or to a cheaper picture).
 *
 * A page event, so whatever offers a top-up needs no handle on the sheet: the host takes the
 * event by cancelling it, and a page that holds no host goes to the pricing page instead.
 */

/** What the sheet is opened for: the run that needs more credits, where one does. */
export type CreditTopUpNeed = { cost: number; balance: number } | null;

/** What the sheet is asked for: the run it is for, and the pricing page it offers beside its packs. */
export interface CreditTopUpRequest {
  need: CreditTopUpNeed;
  pricingHref: string;
}

const OPEN_EVENT = 'credit-top-up:open';

/**
 * Opens the page's top-up sheet, or the pricing page where the page holds none. `pricingHref` is
 * that pricing page, which the sheet also offers ("See every pack"): Pricing, told on a remix the
 * way back to it (`buildRemixTopUpHref`), since a remix keeps no draft.
 */
export function openCreditTopUp(need: CreditTopUpNeed = null, pricingHref = '/pricing') {
  const event = new CustomEvent<CreditTopUpRequest>(OPEN_EVENT, { detail: { need, pricingHref }, cancelable: true });
  // Every creator draws a host; this is the page that holds none.
  if (window.dispatchEvent(event)) window.location.assign(new URL(pricingHref, window.location.origin));
}

/** Takes the page's top-up requests, for the sheet's host. Returns what stops taking them. */
export function onCreditTopUpOpen(open: (request: CreditTopUpRequest) => void) {
  const take = (event: Event) => {
    event.preventDefault();
    open((event as CustomEvent<CreditTopUpRequest>).detail);
  };
  window.addEventListener(OPEN_EVENT, take);
  return () => window.removeEventListener(OPEN_EVENT, take);
}

/** The smallest pack whose credits bring the balance up to the run's cost, or null where none does. */
export function packCoveringNeed<Pack extends { credits: number }>(packs: readonly Pack[], need: CreditTopUpNeed): Pack | null {
  if (!need) return null;
  const short = need.cost - need.balance;
  if (short <= 0) return null;
  return [...packs].sort((a, b) => a.credits - b.credits).find((pack) => pack.credits >= short) ?? null;
}
