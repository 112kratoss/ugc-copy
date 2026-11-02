import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreditTopUpHost } from '@/components/CreditTopUpSheet';
import { openCreditTopUp } from '@/lib/credit-top-up';
import { PRICING_PLANS } from '@/lib/pricing';

// The packs on a creator's page (owner, 2026-11-02): the pricing page's packs and its checkout,
// over the run, which stays set up. The checkout's own cases (a token read after the sheet, a
// capture still pending, a verify that failed after paying) are pricing-page.test.tsx's: the
// two share `useCreditPackCheckout`.

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const sessionState = vi.hoisted(() => ({
  session: null as { access_token: string; user: { id: string } } | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('next/script', () => ({
  default: () => null,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sessionState.session } })),
    },
  },
}));

type RazorpayHandler = (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => Promise<void>;

describe('the top-up sheet', () => {
  const fetchMock = vi.fn();
  let sheet: { options: Record<string, unknown> | null; failed: ((failure: unknown) => void) | null; opened: number };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  class RazorpayStub {
    constructor(options: Record<string, unknown>) {
      sheet.options = options;
    }

    on(event: string, handler: (failure: unknown) => void) {
      if (event === 'payment.failed') sheet.failed = handler;
    }

    open() {
      sheet.opened += 1;
    }
  }

  async function openSheet(need: { cost: number; balance: number } | null = { cost: 19, balance: 3 }, pricingHref?: string) {
    render(<CreditTopUpHost />);
    act(() => openCreditTopUp(need, pricingHref));
    return screen.findByRole('dialog', { name: 'Top up credits' });
  }

  beforeEach(() => {
    fetchMock.mockReset();
    routerMock.push.mockReset();
    window.sessionStorage.clear();
    sessionState.session = { access_token: 'click-token', user: { id: 'buyer-1' } };
    sheet = { options: null, failed: null, opened: 0 };
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/razorpay/order') return json({ orderId: 'order_123', amount: 41500, currency: 'INR' });
      if (url === '/api/razorpay/verify') return json({ success: true });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Razorpay', RazorpayStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stays closed until the page asks for it', () => {
    render(<CreditTopUpHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says what the run costs against the balance, and marks the smallest pack that covers it', async () => {
    const dialog = await openSheet({ cost: 19, balance: 3 });

    expect(dialog).toHaveTextContent('This run costs 19 credits and you have 3. Everything you set up stays on this page.');
    const packs = within(within(dialog).getByRole('list', { name: 'Credit packs' })).getAllByRole('button');
    // The packs and prices the pricing page sells (contracts/credit-packs-v1.json).
    expect(packs.map((pack) => pack.getAttribute('aria-label'))).toEqual(PRICING_PLANS.map((plan, index) => (
      `Buy ${plan.credits.toLocaleString('en-IN')} credits for ₹${plan.priceInr.toLocaleString('en-IN')}${index === 0 ? ', covers this run' : ''}`
    )));
    expect(PRICING_PLANS[0]).toMatchObject({ credits: 500, priceInr: 415 });
    // The first pack takes the focus, as a question's first answer does.
    return waitFor(() => expect(packs[0]).toHaveFocus());
  });

  it('buys a pack through the pricing page\'s checkout, and says so once it is settled', async () => {
    const dialog = await openSheet({ cost: 19, balance: 3 });
    const balanceEvents: Event[] = [];
    const onCreditsUpdated = (event: Event) => balanceEvents.push(event);
    window.addEventListener('credits_updated', onCreditsUpdated);

    try {
      fireEvent.click(within(dialog).getByRole('button', { name: /^Buy 500 credits/ }));
      await waitFor(() => expect(sheet.opened).toBe(1));
      const order = fetchMock.mock.calls.find(([url]) => url === '/api/razorpay/order');
      // The server prices the order from the pack's id; the sheet only names the pack.
      expect(JSON.parse(String((order?.[1] as RequestInit).body))).toMatchObject({ planId: 'starter', userId: 'buyer-1' });
      expect(sheet.options).toMatchObject({ order_id: 'order_123', amount: 41500, currency: 'INR' });

      await act(async () => {
        await (sheet.options?.handler as RazorpayHandler)({ razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_123', razorpay_signature: 'sig' });
      });

      expect(within(dialog).getByRole('status')).toHaveTextContent('Payment successful! Credits added to your account.');
      // The balance the sheet opened with is the account's no longer.
      expect(dialog).not.toHaveTextContent('you have 3');
      expect(balanceEvents).toHaveLength(1);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Back to your run' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      window.removeEventListener('credits_updated', onCreditsUpdated);
    }
  });

  it('says a failed attempt took no money, and keeps the packs to try again', async () => {
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Buy 500 credits/ }));
    await waitFor(() => expect(sheet.opened).toBe(1));

    act(() => sheet.failed?.({ error: { description: 'Card declined' } }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('Payment failed: Card declined');
    expect(within(dialog).getByRole('button', { name: /^Buy 500 credits/ })).toBeEnabled();
  });

  it('cannot be put away while a paid checkout is being confirmed', async () => {
    let releaseVerify: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/razorpay/order') return json({ orderId: 'order_123', amount: 41500, currency: 'INR' });
      if (url === '/api/razorpay/verify') return new Promise<Response>((resolve) => { releaseVerify = resolve; });
      throw new Error(`unexpected fetch ${url}`);
    });
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Buy 500 credits/ }));
    await waitFor(() => expect(sheet.opened).toBe(1));

    let settled: Promise<void> = Promise.resolve();
    act(() => {
      settled = (sheet.options?.handler as RazorpayHandler)({ razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_123', razorpay_signature: 'sig' });
    });
    expect(await within(dialog).findByText('Confirming your payment…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    // Nor led away to Pricing, which would offer the packs again with no word of this payment.
    expect(within(dialog).queryByRole('link', { name: 'See every pack' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Top up credits' })).toBeInTheDocument();

    await act(async () => {
      releaseVerify(json({ success: true }));
      await settled;
    });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeEnabled();
  });

  // The webhook settles a payment the page could not see settle, and the balance is read again
  // for a minute: the sheet is put away long before that minute is out.
  it('keeps reading the balance after the sheet is put away on a payment that went through', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/razorpay/order') return json({ orderId: 'order_123', amount: 41500, currency: 'INR' });
      if (url === '/api/razorpay/verify') return json({ error: 'Unauthorized' }, 401);
      throw new Error(`unexpected fetch ${url}`);
    });
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Buy 500 credits/ }));
    await waitFor(() => expect(sheet.opened).toBe(1));
    const balanceEvents: Event[] = [];
    const onCreditsUpdated = (event: Event) => balanceEvents.push(event);
    window.addEventListener('credits_updated', onCreditsUpdated);
    vi.useFakeTimers();

    try {
      await act(async () => {
        await (sheet.options?.handler as RazorpayHandler)({ razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_123', razorpay_signature: 'sig' });
      });
      expect(within(dialog).getByRole('status')).toHaveTextContent('You do not need to pay again.');
      expect(balanceEvents).toHaveLength(1);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Back to your run' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(balanceEvents).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      window.removeEventListener('credits_updated', onCreditsUpdated);
    }
  });

  // checkout.js draws its sheet in a container of its own, kept in <body> between opens.
  it("leaves Razorpay's checkout live while the page beneath it is put out of reach", async () => {
    const page = document.body.appendChild(document.createElement('div'));
    const checkout = document.body.appendChild(document.createElement('div'));
    checkout.className = 'razorpay-container';
    try {
      await openSheet();
      expect(page.getAttribute('aria-hidden')).toBe('true');
      expect(checkout.getAttribute('aria-hidden')).toBeNull();
      expect(checkout.inert).toBeFalsy();
    } finally {
      page.remove();
      checkout.remove();
    }
  });

  // A pack pressed before checkout.js has arrived (it loads as the sheet opens) waits for it.
  it('waits for the checkout script a pack is pressed before, instead of failing', async () => {
    vi.stubGlobal('Razorpay', undefined);
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Buy 500 credits/ }));
    const script = await waitFor(() => {
      const element = document.getElementById('razorpay-checkout-js');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal('Razorpay', RazorpayStub);
    act(() => { script.dispatchEvent(new Event('load')); });
    await waitFor(() => expect(sheet.opened).toBe(1));
    expect(within(dialog).queryByRole('alert')).toBeNull();
    script.remove();
  });

  // next/script keeps a tag whose load failed and never asks again: waited on, it fired nothing more
  // and the press spun for good. The loader replaces any tag of that id it is not itself waiting on.
  it('fetches checkout.js afresh over a tag of the same id that has already finished', async () => {
    vi.stubGlobal('Razorpay', undefined);
    const stale = document.head.appendChild(document.createElement('script'));
    stale.id = 'razorpay-checkout-js';
    const dialog = await openSheet();
    const fresh = document.getElementById('razorpay-checkout-js');
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(stale);
    expect(stale.isConnected).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: /^Buy 500 credits/ }));
    vi.stubGlobal('Razorpay', RazorpayStub);
    act(() => { fresh!.dispatchEvent(new Event('load')); });
    await waitFor(() => expect(sheet.opened).toBe(1));
    fresh!.remove();
  });

  // A network that sends nothing: the press says so and gives the packs back, rather than spinning.
  it('gives the packs back when checkout.js sends nothing for 20 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.stubGlobal('Razorpay', undefined);
      const dialog = await openSheet();
      fireEvent.click(within(dialog).getByRole('button', { name: /^Buy 500 credits/ }));
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Razorpay checkout could not load. Check your connection and try again.');
      expect(within(dialog).getByRole('button', { name: /^Buy 500 credits/ })).toBeEnabled();
      expect(document.getElementById('razorpay-checkout-js')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // The second click of a double-click on Top Up lands on what its first brought up.
  it('takes no second click of a double-click as a press on the backdrop or a pack', async () => {
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Buy 500 credits/ }), { detail: 2 });
    fireEvent.click(dialog.parentElement!, { detail: 2 });
    expect(screen.getByRole('dialog', { name: 'Top up credits' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(dialog.parentElement!, { detail: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape and on Close, leaving the page as it was', async () => {
    await openSheet();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => openCreditTopUp(null));
    const dialog = await screen.findByRole('dialog', { name: 'Top up credits' });
    expect(dialog).toHaveTextContent('Everything you set up stays on this page.');
    expect(within(dialog).queryByText(/covers this run/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // A remix keeps no draft: the pricing page it offers is told the way back to it (`buildRemixTopUpHref`).
  it('offers the pricing page it was asked for beside the packs', async () => {
    const toRemix = `/pricing?returnTo=${encodeURIComponent('/create-video?remix=gen-1&remixPost=post-1')}`;
    const dialog = await openSheet({ cost: 19, balance: 3 }, toRemix);
    expect(within(dialog).getByRole('link', { name: 'See every pack' })).toHaveAttribute('href', toRemix);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    act(() => openCreditTopUp(null));
    const plain = await screen.findByRole('dialog', { name: 'Top up credits' });
    expect(within(plain).getByRole('link', { name: 'See every pack' })).toHaveAttribute('href', '/pricing');
  });

  it('sends a buyer whose session has ended to sign in, and back to this page', async () => {
    sessionState.session = null;
    window.history.replaceState(null, '', '/create-video?model=seedance-2-5');
    const dialog = await openSheet();

    fireEvent.click(within(dialog).getByRole('button', { name: /^Buy 500 credits/ }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith(`/login?returnUrl=${encodeURIComponent('/create-video?model=seedance-2-5')}`));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
