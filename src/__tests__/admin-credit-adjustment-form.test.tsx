import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CreditAdjustmentForm } from '@/app/admin/(console)/users/[userId]/CreditAdjustmentForm';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('admin credit adjustment confirmation balances', () => {
  it.each([
    { label: 'Goodwill grant', total: '500 → 507', promotional: '0 → 7', debt: false },
    { label: 'Restore purchased credits', total: '500 → 507', promotional: '0 → 0', debt: false },
    { label: 'Clawback', total: '500 → 493', promotional: '0 → -7', debt: true },
  ])('previews $label without applying it', ({ label, total, promotional, debt }) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<CreditAdjustmentForm userId="10000000-0000-4000-8000-000000000001" credits={500} promotionalCredits={0} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'local audit fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
    const confirmation = screen.getByRole('alert');
    const values = Array.from(confirmation.querySelectorAll('dd'), value => value.textContent?.replace(/\s+/g, ' ').trim());
    expect(screen.getByText('Total credits')).toBeInTheDocument();
    expect(values).toEqual([total, promotional]);
    expect(confirmation.textContent?.includes('leaves the account in debt')).toBe(debt);
    expect(fetch).not.toHaveBeenCalled();
  });
});
