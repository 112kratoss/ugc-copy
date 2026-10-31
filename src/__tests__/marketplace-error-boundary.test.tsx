import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// One navigation object for every render, as Next's is.
const navigation = vi.hoisted(() => ({ pathname: '/marketplace' }));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
}));

import MarketplaceError from '@/app/marketplace/error';

// A failed read under /marketplace showed Next's bare error page: no message
// of the app's own and no retry, the seller's payout panel included.
describe('the marketplace error boundary', () => {
  beforeEach(() => {
    navigation.pathname = '/marketplace';
  });

  it("offers the seller a retry of their dashboard, which refetches the route", () => {
    navigation.pathname = '/marketplace/sell';
    const retry = vi.fn();

    render(<MarketplaceError retry={retry} />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'Could not load your recipe sales' })).toBeInTheDocument();
    expect(alert).toHaveTextContent('Your recipes, sales and payout balance are safe.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry dashboard' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('offers a retry of the storefront', () => {
    const retry = vi.fn();

    render(<MarketplaceError retry={retry} />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'Could not load the marketplace' })).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
