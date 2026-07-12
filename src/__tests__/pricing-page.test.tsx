import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerPushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}));

vi.mock('next/script', () => ({
  default: () => null,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: null },
      })),
      getSession: vi.fn(async () => ({
        data: { session: null },
      })),
    },
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
    routerPushMock.mockReset();
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

  it('shows the referral benefit next to credit-pack pricing', async () => {
    const { PricingClient } = await import('@/app/pricing/PricingClient');
    render(<PricingClient initialCountryCode="IN" />);

    expect(screen.getByText('Invite friends. Earn creation credits.')).toBeInTheDocument();
    expect(screen.getByText(/Your friend gets 5% bonus credits/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Invite & Earn/i })).toHaveAttribute('href', '/invite');
  });
});
