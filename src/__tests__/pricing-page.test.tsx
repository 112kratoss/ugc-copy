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

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    routerPushMock.mockReset();
    window.localStorage.clear();

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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the currency preference from the legacy emptybooklet key and rewrites future changes to the new key', async () => {
    window.localStorage.setItem('emptybooklet_currency', 'EUR');

    const { default: PricingPage } = await import('@/app/pricing/page');
    render(<PricingPage />);

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

    const { default: PricingPage } = await import('@/app/pricing/page');
    render(<PricingPage />);

    const select = await screen.findByLabelText('Currency');

    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('USD');
    });
  });
});
