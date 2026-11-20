import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OWN_PROFILE_COLUMNS } from '@/lib/browser-account-reads';

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

// The browser's session cookie, which @supabase/ssr keeps the session in: there whenever a session
// is, unless a case says otherwise. Read with no argument in the browser (the page loads the
// Supabase client only with one); the server's read of a request's header is the real one.
const cookieState = vi.hoisted(() => ({ present: null as boolean | null }));
vi.mock('@/lib/supabase-auth-cookie', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/supabase-auth-cookie')>();
  return {
    ...original,
    hasSupabaseAuthCookie: (...args: Parameters<typeof original.hasSupabaseAuthCookie>) => (
      args.length > 0 ? original.hasSupabaseAuthCookie(...args) : cookieState.present ?? sessionState.session !== null
    ),
  };
});

beforeEach(() => {
  cookieState.present = null;
});

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

  // /api/fx sends no `updatedAt` for a provider stamp it cannot read (fx-rates-service.ts): the
  // prices are converted, and no line says when the rates were read.
  it('says when the rates were read only when the route says it', async () => {
    let answerFx!: (response: Response) => void;
    fetchMock.mockImplementation((input: RequestInfo | URL) => (String(input) === '/api/fx'
      ? new Promise<Response>((resolve) => {
        answerFx = resolve;
      })
      : Promise.resolve(new Response('{}', { status: 404 }))));
    window.localStorage.setItem('magicbooklet_currency', 'USD');

    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="US" />);

    expect(await screen.findByText('Updating FX...')).toBeInTheDocument();
    await act(async () => {
      answerFx(new Response(JSON.stringify({ base: 'INR', rates: { INR: 1, USD: 0.012, EUR: 0.011 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    await waitFor(() => expect(screen.queryByText('Updating FX...')).not.toBeInTheDocument());
    expect(screen.queryByText('FX unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText(/Rates updated/)).not.toBeInTheDocument();
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
    // The page's one read of the buyer's row, which the top bar's balance shares (browser-account-reads.ts).
    expect(profileState.reads).toEqual([{ table: 'profiles', columns: OWN_PROFILE_COLUMNS, column: 'id', value: 'buyer-1' }]);
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

  describe('when the request carried a session cookie', () => {
    it('draws the balance card from the first render, before the session is read', async () => {
      const { PricingClient } = await import('@/app/pricing/PricingClient');
      const { supabase } = await import('@/lib/supabase');
      // A session that has not answered yet: a signed-in refresh before getSession returns.
      vi.mocked(supabase.auth.getSession).mockReturnValueOnce(new Promise(() => undefined));
      render(<PricingClient initialCountryCode="IN" sessionCookieHint />);

      // Synchronously: the card sits where it will stay, so nothing below it moves (2026-11-14).
      expect(screen.getByText('Available balance')).toBeInTheDocument();
      expect(screen.getByText('Balance loading…')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Credit history' })).toHaveAttribute('href', '/credits');
      expect(profileState.reads).toEqual([]);
    });

    it("draws it in the server's HTML too", async () => {
      const { renderToString } = await import('react-dom/server');
      const { PricingClient } = await import('@/app/pricing/PricingClient');

      expect(renderToString(<PricingClient initialCountryCode="IN" sessionCookieHint />)).toContain('Available balance');
      expect(renderToString(<PricingClient initialCountryCode="IN" />)).not.toContain('Available balance');
    });

    it('keeps the card and fills in the balance once the session answers', async () => {
      const { PricingClient } = await import('@/app/pricing/PricingClient');
      render(<PricingClient initialCountryCode="IN" sessionCookieHint />);

      expect(await screen.findByText('1,295 credits')).toBeInTheDocument();
      expect(screen.getAllByText('Available balance')).toHaveLength(1);
    });

    it('takes the card away when the cookie held no session', async () => {
      sessionState.session = null;
      cookieState.present = true;
      const { PricingClient } = await import('@/app/pricing/PricingClient');
      render(<PricingClient initialCountryCode="IN" sessionCookieHint />);
      expect(screen.getByText('Available balance')).toBeInTheDocument();

      await waitFor(() => expect(screen.queryByText('Available balance')).toBeNull());
      expect(screen.queryByRole('link', { name: 'Credit history' })).toBeNull();
      expect(profileState.reads).toEqual([]);
    });

    // The client the session is read with did not load (browser-session.ts): that is no sign of
    // being signed out, so the card stays, saying the balance did not load; a press says why.
    it('keeps the card, saying the balance did not load, when the client did not load', async () => {
      const { PricingClient } = await import('@/app/pricing/PricingClient');
      const { setBrowserSupabaseImportForTests } = await import('@/lib/browser-session');
      setBrowserSupabaseImportForTests(() => Promise.reject(new Error('Loading chunk 1p-ooj54jv0t9 failed.')));
      render(<PricingClient initialCountryCode="IN" sessionCookieHint />);

      expect(await screen.findByText('Balance did not load')).toBeInTheDocument();
      expect(screen.getByText('Available balance')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Credit history' })).toHaveAttribute('href', '/credits');
      expect(screen.queryByText('Balance loading…')).toBeNull();
      expect(profileState.reads).toEqual([]);
    });
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
    expect(element.props).toEqual({ initialCountryCode: 'IN', referralProgram: terms, returnTo: null, sessionCookieHint: false });
  });

  it('passes null, never made-up numbers, while no program can be read', async () => {
    pageMocks.headers.mockResolvedValue(new Headers());
    pageMocks.loadReferralProgramTerms.mockResolvedValue(null);

    const { default: Pricing } = await import('@/app/pricing/page');
    const element = await Pricing();

    expect(element.props).toEqual({ initialCountryCode: null, referralProgram: null, returnTo: null, sessionCookieHint: false });
  });

  it("tells the client whether the request carried this project's session cookie, whole or in chunks", async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    pageMocks.loadReferralProgramTerms.mockResolvedValue(null);
    const { default: Pricing } = await import('@/app/pricing/page');
    const hintFor = async (cookie: string | null) => {
      pageMocks.headers.mockResolvedValue(new Headers(cookie === null ? {} : { cookie }));
      return (await Pricing()).props.sessionCookieHint;
    };

    try {
      expect(await hintFor('sb-example-auth-token=base64-abc')).toBe(true);
      expect(await hintFor('theme=dark; sb-example-auth-token.0=base64-abc; sb-example-auth-token.1=def')).toBe(true);
      // Another project's cookie, the PKCE verifier alone, or none at all is no session.
      expect(await hintFor('sb-other-auth-token=base64-abc')).toBe(false);
      expect(await hintFor('sb-example-auth-token-code-verifier=xyz')).toBe(false);
      expect(await hintFor(null)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
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

  it('sends a buyer whose cookie holds no session any more to sign in, reading it with the client', async () => {
    sessionState.session = null;
    cookieState.present = true;
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    const { supabase } = await import('@/lib/supabase');
    vi.mocked(supabase.auth.getSession).mockClear();
    render(<PricingClient initialCountryCode="IN" />);

    fireEvent.click(screen.getByRole('button', { name: 'Get 500 Credits' }));

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith('/login?redirect=/pricing');
    });
    expect(supabase.auth.getSession).toHaveBeenCalled();
    expect(requestsTo('/api/razorpay/order')).toHaveLength(0);
  });

  // The client that reads the buyer's session no longer comes with the page. Its code can fail to
  // load (offline, a deploy that rotated the chunk names), and in a production build no retry
  // fetches it again: the press orders nothing and offers the reload that can.
  it('orders nothing when the client did not load, says so, and offers a reload, press after press', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    const { setBrowserSupabaseImportForTests } = await import('@/lib/browser-session');
    const load = vi.fn(() => Promise.reject(new Error('Loading chunk 1p-ooj54jv0t9 failed.')));
    setBrowserSupabaseImportForTests(load);
    routerMock.push.mockClear();
    render(<PricingClient initialCountryCode="IN" />);
    const pack = screen.getByRole('button', { name: 'Get 500 Credits' });

    fireEvent.click(pack);

    const said = await screen.findByRole('alert');
    expect(said).toHaveTextContent('Checkout did not load. Try again reloads the page.');
    expect(requestsTo('/api/razorpay/order')).toHaveLength(0);
    expect(sheet.opened).toBe(0);
    expect(routerMock.push).not.toHaveBeenCalled();
    await waitFor(() => expect(pack).toBeEnabled());

    // The next press asks again and, the client still missing, says the same and orders nothing.
    const loadsBefore = load.mock.calls.length;
    fireEvent.click(pack);
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(loadsBefore));
    await waitFor(() => expect(pack).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent('Checkout did not load. Try again reloads the page.');
    expect(requestsTo('/api/razorpay/order')).toHaveLength(0);

    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // While the client's code is on its way the press is under way: the pack says so, and a second
  // press, on it or on another pack, is the same press (review of #883).
  it('makes one order and opens one sheet for presses made while the client is still loading', async () => {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    const browserSession = await import('@/lib/browser-session');
    const client = await import('@/lib/supabase');
    let deliver: () => void = () => undefined;
    browserSession.setBrowserSupabaseImportForTests(() => new Promise((resolve) => {
      deliver = () => resolve(client);
    }));
    render(<PricingClient initialCountryCode="IN" />);

    fireEvent.click(screen.getByRole('button', { name: 'Get 500 Credits' }));

    // Under way from the press on, before the session has been read.
    expect(screen.getByRole('button', { name: /Processing/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Processing/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Get 2,000 Credits' }));

    await act(async () => {
      deliver();
      await Promise.resolve();
    });
    await waitFor(() => expect(sheet.opened).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(requestsTo('/api/razorpay/order')).toHaveLength(1);
    expect(JSON.parse(String((requestsTo('/api/razorpay/order')[0][1] as RequestInit).body))).toMatchObject({ planId: 'starter' });
    expect(sheet.opened).toBe(1);
  });

  // checkout.js, with the hidden Razorpay frame it opens (about 790 KB in 55 requests), was
  // fetched on every view of the page, a visitor's too (2026-11-19): now when a buyer reaches for
  // a pack, and in any case by the press, which waits for it before it orders.
  describe('checkout.js', () => {
    const checkoutTags = () => document.querySelectorAll('script#razorpay-checkout-js');

    beforeEach(() => {
      vi.stubGlobal('Razorpay', undefined);
    });

    afterEach(() => {
      checkoutTags().forEach((tag) => tag.remove());
    });

    it('is not fetched as the page shows, and is once a buyer reaches for a pack', async () => {
      const { PricingClient } = await import('@/app/pricing/PricingClient');
      render(<PricingClient initialCountryCode="IN" />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(checkoutTags()).toHaveLength(0);

      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Get 500 Credits' }));
      expect(checkoutTags()).toHaveLength(1);
      // Another pack, from the keyboard: the fetch already under way serves it.
      fireEvent.focus(screen.getByRole('button', { name: 'Get 2,000 Credits' }));
      expect(checkoutTags()).toHaveLength(1);
      expect(sheet.opened).toBe(0);
      expect(requestsTo('/api/razorpay/order')).toHaveLength(0);
    });

    it('is fetched by a press nothing announced, which orders only once it has arrived', async () => {
      const { PricingClient } = await import('@/app/pricing/PricingClient');
      render(<PricingClient initialCountryCode="IN" />);

      fireEvent.click(screen.getByRole('button', { name: 'Get 500 Credits' }));

      const tag = await waitFor(() => {
        const element = document.getElementById('razorpay-checkout-js');
        expect(element).not.toBeNull();
        return element!;
      });
      expect(screen.getByRole('button', { name: /Processing/ })).toBeDisabled();
      expect(requestsTo('/api/razorpay/order')).toHaveLength(0);

      vi.stubGlobal('Razorpay', RazorpayStub);
      act(() => {
        tag.dispatchEvent(new Event('load'));
      });
      await waitFor(() => expect(sheet.opened).toBe(1));
      expect(requestsTo('/api/razorpay/order')).toHaveLength(1);
      expect(checkoutTags()).toHaveLength(1);
    });

    it('serves a press from the fetch the pointer started, with no second one', async () => {
      const { PricingClient } = await import('@/app/pricing/PricingClient');
      render(<PricingClient initialCountryCode="IN" />);
      const pack = screen.getByRole('button', { name: 'Get 500 Credits' });

      fireEvent.pointerEnter(pack);
      const tag = document.getElementById('razorpay-checkout-js');
      expect(tag).not.toBeNull();
      fireEvent.click(pack);
      await waitFor(() => expect(screen.getByRole('button', { name: /Processing/ })).toBeDisabled());
      expect(checkoutTags()).toHaveLength(1);
      expect(document.getElementById('razorpay-checkout-js')).toBe(tag);

      vi.stubGlobal('Razorpay', RazorpayStub);
      act(() => {
        tag!.dispatchEvent(new Event('load'));
      });
      await waitFor(() => expect(sheet.opened).toBe(1));
      expect(requestsTo('/api/razorpay/order')).toHaveLength(1);
    });

    it('is never fetched for a visitor, whose press goes to sign in without loading the Supabase client', async () => {
      sessionState.session = null;
      const { PricingClient } = await import('@/app/pricing/PricingClient');
      const { supabase } = await import('@/lib/supabase');
      vi.mocked(supabase.auth.getSession).mockClear();
      render(<PricingClient initialCountryCode="IN" />);
      const pack = screen.getByRole('button', { name: 'Get 500 Credits' });

      fireEvent.pointerEnter(pack);
      fireEvent.focus(pack);
      fireEvent.click(pack);

      await waitFor(() => {
        expect(routerMock.push).toHaveBeenCalledWith('/login?redirect=/pricing');
      });
      expect(checkoutTags()).toHaveLength(0);
      expect(supabase.auth.getSession).not.toHaveBeenCalled();
    });
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
