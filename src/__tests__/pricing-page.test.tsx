import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import creditPacksContract from '../../contracts/credit-packs-v1.json';

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const sessionState = vi.hoisted(() => ({
  session: null as { access_token: string; user: { id: string } } | null,
}));
const pageMocks = vi.hoisted(() => ({
  headers: vi.fn(),
  loadReferralProgramTerms: vi.fn(),
}));
/** The signed-in buyer's `profiles` row, read for the balance beside the credit history link. */
const profileState = vi.hoisted(() => ({
  credits: 1295 as number | null,
  reads: [] as Array<{ table: string; columns: string; column: string; value: unknown }>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('next/script', () => ({
  default: () => null,
}));

vi.mock('next/headers', () => ({
  headers: () => pageMocks.headers(),
}));

vi.mock('@/lib/referral-route-service', () => ({
  loadReferralProgramTerms: () => pageMocks.loadReferralProgramTerms(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: null },
      })),
      getSession: vi.fn(async () => ({
        data: { session: sessionState.session },
      })),
    },
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: unknown) => ({
          maybeSingle: async () => {
            profileState.reads.push({ table, columns, column, value });
            return { data: profileState.credits === null ? null : { credits: profileState.credits }, error: null };
          },
        }),
      }),
    }),
  },
}));

describe('pricing page currency storage', () => {
  const fetchMock = vi.fn();
  const defaultNavigatorLanguages = Array.from(window.navigator.languages);

  function stubNavigatorLanguages(languages: string[]) {
    Object.defineProperty(window.navigator, 'languages', {
      configurable: true,
      value: languages,
    });
  }

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    routerMock.push.mockReset();
    sessionState.session = null;
    window.localStorage.clear();
    stubNavigatorLanguages(defaultNavigatorLanguages);

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          base: 'INR',
          rates: {
            INR: 1,
            USD: 0.012,
            EUR: 0.011,
          },
          updatedAt: '2026-05-06T12:00:00.000Z',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    stubNavigatorLanguages(defaultNavigatorLanguages);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the currency preference from the legacy emptybooklet key and rewrites future changes to the new key', async () => {
    window.localStorage.setItem('emptybooklet_currency', 'EUR');

    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    const select = await screen.findByLabelText('Currency');

    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('EUR');
    });

    fireEvent.change(select, { target: { value: 'USD' } });

    expect(window.localStorage.getItem('magicbooklet_currency')).toBe('USD');
    expect(window.localStorage.getItem('emptybooklet_currency')).toBeNull();
    expect(window.localStorage.getItem('ugc_currency')).toBeNull();
  });

  it('loads the currency preference from the legacy ugc key when the newer keys are absent', async () => {
    window.localStorage.setItem('ugc_currency', 'USD');

    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    const select = await screen.findByLabelText('Currency');

    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('USD');
    });
  });

  it('defaults to INR for detected India visitors even when the browser locale is US English', async () => {
    stubNavigatorLanguages(['en-US']);

    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    const select = await screen.findByLabelText('Currency');

    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('INR');
    });
  });

  it('keeps the current manual currency preference over detected India', async () => {
    window.localStorage.setItem('magicbooklet_currency', 'USD');
    stubNavigatorLanguages(['en-IN']);

    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    const select = await screen.findByLabelText('Currency');

    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('USD');
    });
  });

  it('falls back to navigator locale when the country header is unavailable', async () => {
    stubNavigatorLanguages(['en-IN']);

    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient />);

    const select = await screen.findByLabelText('Currency');

    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('INR');
    });
  });

  it('falls back to USD for US browser locale when the country header is unavailable', async () => {
    stubNavigatorLanguages(['en-US']);

    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient />);

    const select = await screen.findByLabelText('Currency');

    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('USD');
    });
  });

  it('shows the referral benefit next to credit-pack pricing, in the live program terms', async () => {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(
      <PricingClient
        initialCountryCode="IN"
        referralProgram={{ inviterPercent: 7, inviteeFirstPurchasePercent: 2.5 }}
      />
    );

    expect(screen.getByText('Invite friends. Earn creation credits.')).toBeInTheDocument();
    expect(screen.getByText(
      'Your friend gets 2.5% bonus credits on their first verified top-up. You earn 7% bonus credits every time they top up.'
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Invite & Earn/i })).toHaveAttribute('href', '/invite');
  });

  it('leaves the numbers out when the program terms cannot be read', async () => {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" referralProgram={null} />);

    expect(screen.getByText(
      'Your friend gets bonus credits on their first verified top-up. You earn bonus credits every time they top up.'
    )).toBeInTheDocument();
    expect(screen.queryByText(/\d+(\.\d+)?% bonus/)).toBeNull();
  });

  it('prints the packs, and the featured label, the contract defines, with no HD claim', async () => {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    const { container } = render(<PricingClient initialCountryCode="IN" />);

    for (const pack of creditPacksContract.packs) {
      expect(screen.getByRole('heading', { level: 2, name: pack.name })).toBeInTheDocument();
      expect(screen.getByText(pack.description)).toBeInTheDocument();
    }
    const badges = creditPacksContract.packs.flatMap((pack) => (pack.badge ? [pack.badge] : []));
    expect(badges).toEqual(['Most popular']);
    expect(screen.getAllByText('Most popular')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/\bHD\b/);
  });
});

describe('pricing page balance and credit history link', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    sessionState.session = { access_token: 'buyer-token', user: { id: 'buyer-1' } };
    profileState.credits = 1295;
    profileState.reads = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ base: 'INR', rates: { INR: 1, USD: 0.012 }, updatedAt: '2026-10-15' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a signed-in buyer's balance beside the way to the credit history", async () => {
    profileState.credits = 150000;
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    expect(await screen.findByText('1,50,000 credits')).toBeInTheDocument();
    expect(screen.getByText('Available balance')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Credit history' })).toHaveAttribute('href', '/credits');
    expect(profileState.reads).toEqual([{ table: 'profiles', columns: 'credits', column: 'id', value: 'buyer-1' }]);
  });

  it('reads the balance again whenever the page is told it moved', async () => {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);
    // The first read is made by the effect that also starts listening.
    expect(await screen.findByText('1,295 credits')).toBeInTheDocument();

    profileState.credits = 1795;
    await act(async () => {
      window.dispatchEvent(new Event('credits_updated'));
    });

    expect(await screen.findByText('1,795 credits')).toBeInTheDocument();
    expect(profileState.reads).toHaveLength(2);
  });

  it("says the balance is loading, in the app's words and never as 0, while it is not known", async () => {
    profileState.credits = null;
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    expect(await screen.findByRole('link', { name: 'Credit history' })).toBeInTheDocument();
    expect(screen.getByText('Balance loading…')).toBeInTheDocument();
    expect(screen.queryByText(/^0 credits$/)).toBeNull();
  });

  it('shows neither to a signed-out visitor', async () => {
    sessionState.session = null;
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    await screen.findByLabelText('Currency');
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText('Available balance')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Credit history' })).toBeNull();
    expect(profileState.reads).toEqual([]);
  });
});

describe('pricing page server render', () => {
  beforeEach(() => {
    vi.resetModules();
    pageMocks.headers.mockReset();
    pageMocks.loadReferralProgramTerms.mockReset();
  });

  it('hands the client the live Invite & Earn terms read on the server', async () => {
    const terms = { inviterPercent: 5, inviteeFirstPurchasePercent: 5, attributionWindowDays: 30 };
    pageMocks.headers.mockResolvedValue(new Headers({ 'x-vercel-ip-country': 'IN' }));
    pageMocks.loadReferralProgramTerms.mockResolvedValue(terms);

    const { default: Pricing } = await import('@/app/pricing/page');
    const element = await Pricing();

    // No recipe to go back to on a plain visit.
    expect(element.props).toEqual({ initialCountryCode: 'IN', referralProgram: terms, returnTo: null });
  });

  it('passes null, never made-up numbers, while no program can be read', async () => {
    pageMocks.headers.mockResolvedValue(new Headers());
    pageMocks.loadReferralProgramTerms.mockResolvedValue(null);

    const { default: Pricing } = await import('@/app/pricing/page');
    const element = await Pricing();

    expect(element.props).toEqual({ initialCountryCode: null, referralProgram: null, returnTo: null });
  });
});

type RazorpayHandler = (response: {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}) => Promise<void>;

describe('pricing page checkout', () => {
  const INTENT_STORAGE_KEY = 'magicbooklet:razorpay-checkout:credits:starter';
  const fetchMock = vi.fn();
  let verifyResponses: Array<() => Promise<Response>> = [];
  let orderResponse: () => Response;
  let sheet: { options: Record<string, unknown> | null; failed: ((failure: unknown) => void) | null; opened: number };
  let alertSpy: ReturnType<typeof vi.spyOn>;

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  function requestsTo(path: string) {
    return fetchMock.mock.calls.filter(([url]) => url === path);
  }

  function bearerOf(call: unknown[] | undefined) {
    return ((call?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.Authorization;
  }

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

  async function openSheetForStarter(returnTo: string | null = null) {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" returnTo={returnTo} />);
    fireEvent.click(screen.getByRole('button', { name: 'Get 500 Credits' }));
    await waitFor(() => {
      expect(sheet.opened).toBe(1);
    });
    return sheet.options?.handler as RazorpayHandler;
  }

  const payment = {
    razorpay_payment_id: 'pay_123',
    razorpay_order_id: 'order_123',
    razorpay_signature: 'signature',
  };

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    window.sessionStorage.clear();
    sessionState.session = { access_token: 'click-token', user: { id: 'buyer-1' } };
    sheet = { options: null, failed: null, opened: 0 };
    verifyResponses = [];
    orderResponse = () => json({ orderId: 'order_123', amount: 41500, currency: 'INR' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/fx') return json({ base: 'INR', rates: { INR: 1, USD: 0.012 }, updatedAt: '2026-10-15' });
      if (url === '/api/razorpay/order') return orderResponse();
      if (url === '/api/razorpay/verify') {
        const next = verifyResponses.shift();
        if (!next) throw new Error('unexpected verify call');
        return next();
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Razorpay', RazorpayStub);
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // B-F8: a buyer who came from a recipe is offered the recipe, not Studio.
  it('leads a settled payment back to the recipe the buyer came from', async () => {
    verifyResponses.push(async () => json({ success: true }));
    const handler = await openSheetForStarter('/showcase/post-1#recipe');

    await act(async () => {
      await handler(payment);
    });

    expect(screen.getByRole('status')).toHaveTextContent('Payment successful! Credits added to your account.');
    expect(screen.getAllByRole('link', { name: 'Back to the recipe' }).map((link) => link.getAttribute('href')))
      .toEqual(['/showcase/post-1#recipe', '/showcase/post-1#recipe']);
    expect(screen.queryByRole('link', { name: 'Start creating' })).toBeNull();
  });

  // A remix keeps no draft: its Top up tells Pricing the remix, and a settled payment leads back to it.
  it('leads a settled payment back to the remix the creator came from', async () => {
    verifyResponses.push(async () => json({ success: true }));
    const handler = await openSheetForStarter('/create-video?remix=gen-1&remixPost=post-1');

    await act(async () => {
      await handler(payment);
    });

    expect(screen.getByRole('status')).toHaveTextContent('Payment successful! Credits added to your account. Back to your remix');
    expect(screen.getAllByRole('link', { name: 'Back to your remix' }).map((link) => link.getAttribute('href')))
      .toEqual(['/create-video?remix=gen-1&remixPost=post-1', '/create-video?remix=gen-1&remixPost=post-1']);
    expect(screen.queryByRole('link', { name: 'Back to the recipe' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Start creating' })).toBeNull();
  });

  it('confirms a settled payment inline with a token read after the sheet, and refreshes the balance', async () => {
    let releaseVerify: (response: Response) => void = () => undefined;
    verifyResponses.push(() => new Promise<Response>((resolve) => { releaseVerify = resolve; }));
    const handler = await openSheetForStarter();
    expect(bearerOf(requestsTo('/api/razorpay/order')[0])).toBe('Bearer click-token');
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeTruthy();
    const balanceEvents: Event[] = [];
    const onCreditsUpdated = (event: Event) => balanceEvents.push(event);
    window.addEventListener('credits_updated', onCreditsUpdated);

    try {
      // Minutes in the sheet: the session has a new token by the time it returns.
      sessionState.session = { access_token: 'fresh-token', user: { id: 'buyer-1' } };
      let settled: Promise<void> = Promise.resolve();
      act(() => {
        settled = handler(payment);
      });

      expect(await screen.findByText('Confirming your payment…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Get 2,000 Credits' })).toBeDisabled();

      await act(async () => {
        releaseVerify(json({ success: true }));
        await settled;
      });

      expect(screen.getByRole('status')).toHaveTextContent('Payment successful! Credits added to your account.');
      expect(screen.getByRole('link', { name: 'Start creating' })).toHaveAttribute('href', '/create');
      expect(bearerOf(requestsTo('/api/razorpay/verify')[0])).toBe('Bearer fresh-token');
      expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
      expect(balanceEvents).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Get 2,000 Credits' })).toBeEnabled();
      expect(alertSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('credits_updated', onCreditsUpdated);
    }
  });

  it('says a payment awaiting capture will arrive, and keeps reading the balance for a minute', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      verifyResponses.push(async () => json({
        success: false,
        status: 'pending',
        code: 'PAYMENT_PENDING',
        retryAfterSeconds: 2,
      }, 202));
    }
    const handler = await openSheetForStarter();
    const balanceEvents: Event[] = [];
    const onCreditsUpdated = (event: Event) => balanceEvents.push(event);
    window.addEventListener('credits_updated', onCreditsUpdated);

    try {
      vi.useFakeTimers();
      let settled: Promise<void> = Promise.resolve();
      act(() => {
        settled = handler(payment);
      });
      expect(screen.getByText('Confirming your payment…')).toBeInTheDocument();
      // Four two-second waits between the five verify attempts.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
        await settled;
      });

      expect(requestsTo('/api/razorpay/verify')).toHaveLength(5);
      expect(screen.getByRole('status')).toHaveTextContent(
        'Payment received and waiting for capture. Your credits will appear automatically once Razorpay confirms it.'
      );
      expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
      expect(balanceEvents).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(balanceEvents).toHaveLength(7);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      const afterAMinute = balanceEvents.length;
      expect(afterAMinute).toBeGreaterThanOrEqual(12);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(balanceEvents).toHaveLength(afterAMinute);
      expect(alertSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('credits_updated', onCreditsUpdated);
    }
  });

  it('tells a buyer whose verify answered 401 after paying that the payment went through', async () => {
    verifyResponses.push(async () => json({ error: 'Unauthorized' }, 401));
    const handler = await openSheetForStarter();
    const balanceEvents: Event[] = [];
    const onCreditsUpdated = (event: Event) => balanceEvents.push(event);
    window.addEventListener('credits_updated', onCreditsUpdated);

    try {
      await act(async () => {
        await handler(payment);
      });

      const status = screen.getByRole('status');
      expect(status).toHaveTextContent(
        'Your payment went through and your credits will appear in your balance shortly. You do not need to pay again.'
      );
      expect(status).not.toHaveTextContent(/unauthorized|try again/i);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Start creating' })).toBeNull();
      // The next checkout must not replay this paid order.
      expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
      // The webhook settles it; the balance is read again until it shows.
      expect(balanceEvents).toHaveLength(1);
      expect(alertSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('credits_updated', onCreditsUpdated);
    }
  });

  it('says the payment went through when the session is gone by the time the sheet returns', async () => {
    const handler = await openSheetForStarter();
    sessionState.session = null;

    await act(async () => {
      await handler(payment);
    });

    expect(requestsTo('/api/razorpay/verify')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('Your payment went through');
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
  });

  it('shows an order refusal inline, before any money moves', async () => {
    orderResponse = () => json({ error: 'This checkout changed. Start it again.', code: 'CHECKOUT_PAYLOAD_MISMATCH' }, 409);
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    fireEvent.click(screen.getByRole('button', { name: 'Get 500 Credits' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This checkout changed. Start it again.');
    expect(sheet.opened).toBe(0);
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole('button', { name: 'Get 500 Credits' })).toBeEnabled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('keeps the intent key when the order is refused for another reason', async () => {
    orderResponse = () => json({ error: 'Too many checkout attempts.' }, 429);
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    fireEvent.click(screen.getByRole('button', { name: 'Get 500 Credits' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many checkout attempts.');
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeTruthy();
  });

  it('shows a failed attempt inside the sheet inline', async () => {
    await openSheetForStarter();

    act(() => {
      sheet.failed?.({ error: { description: 'Your card was declined.' } });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Payment failed: Your card was declined.');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('sends a signed-out buyer to sign in and back', async () => {
    sessionState.session = null;
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    fireEvent.click(screen.getByRole('button', { name: 'Get 500 Credits' }));

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith('/login?redirect=/pricing');
    });
    expect(requestsTo('/api/razorpay/order')).toHaveLength(0);
  });
});

// B-F8 (2026-10-27): "Buy credits" on a recipe led to Pricing, whose only ways
// on were "Back to Home" and, after paying, "Start creating"; the buyer had to
// find the recipe again. Pricing takes the recipe's path and offers it back.
describe('pricing page sent from a recipe or a remix', () => {
  beforeEach(() => {
    vi.resetModules();
    sessionState.session = null;
    pageMocks.headers.mockResolvedValue(new Headers());
    pageMocks.loadReferralProgramTerms.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ base: 'INR', rates: { INR: 1, USD: 0.012 }, updatedAt: '2026-10-15' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers the way back to the recipe in place of Home', async () => {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" returnTo="/showcase/post-1?from=home#recipe" />);

    expect(await screen.findByRole('link', { name: 'Back to the recipe' })).toHaveAttribute('href', '/showcase/post-1?from=home#recipe');
    expect(screen.queryByRole('link', { name: 'Back to Home' })).toBeNull();
  });

  it('keeps Home without one', async () => {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    expect(await screen.findByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/');
  });

  it('takes the recipe from the address, and only a path on this site', async () => {
    const { default: Pricing } = await import('@/app/pricing/page');

    const fromRecipe = render(await Pricing({ searchParams: Promise.resolve({ returnTo: '/showcase/post-1#recipe' }) }));
    expect(await screen.findByRole('link', { name: 'Back to the recipe' })).toHaveAttribute('href', '/showcase/post-1#recipe');
    fromRecipe.unmount();

    render(await Pricing({ searchParams: Promise.resolve({ returnTo: 'https://evil.example/showcase' }) }));
    expect(await screen.findByRole('link', { name: 'Back to Home' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to the recipe' })).toBeNull();
  });

  // A remix keeps no draft, so its Top up tells Pricing the remix too (2026-11-02): the way
  // back is named by where it goes, not "Back to the recipe" for every page.
  it('offers the way back to a remix, named for it', async () => {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" returnTo="/create-image?remix=gen-1&remixPost=post-1" />);

    expect(await screen.findByRole('link', { name: 'Back to your remix' })).toHaveAttribute('href', '/create-image?remix=gen-1&remixPost=post-1');
    expect(screen.queryByRole('link', { name: 'Back to the recipe' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Back to Home' })).toBeNull();
  });

  it('names any other way back plainly', async () => {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" returnTo="/credits" />);

    expect(await screen.findByRole('link', { name: 'Go back' })).toHaveAttribute('href', '/credits');
    expect(screen.queryByRole('link', { name: 'Back to the recipe' })).toBeNull();
  });

  // The address a remix's Top up opens, read as the page reads it: decoded once.
  it('takes the remix from its Top up\'s address', async () => {
    const { default: Pricing } = await import('@/app/pricing/page');
    const { buildRemixTopUpHref } = await import('@/lib/pricing-return');
    const topUp = new URL(buildRemixTopUpHref('video', 'gen-1', 'post-1'), 'https://magicbooklet.com');
    expect(topUp.pathname).toBe('/pricing');

    render(await Pricing({ searchParams: Promise.resolve(Object.fromEntries(topUp.searchParams)) }));
    expect(await screen.findByRole('link', { name: 'Back to your remix' })).toHaveAttribute('href', '/create-video?remix=gen-1&remixPost=post-1');
  });
});
