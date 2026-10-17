import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import TermsOfService from '@/app/terms/page';
import { siteConfig } from '@/lib/seo';

describe('Terms of Service', () => {
  // Decision 7b (2026-10-17): the seller payout terms follow Invite & Earn as
  // section 6, in the owner's words, and every section after it moves down one.
  // The exchange-rate sentence was added at the owner's request on 2026-10-18.
  it('states the seller payout terms as section 6 and numbers the sections after it', () => {
    render(<TermsOfService />);

    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      '1. Acceptance of Terms and Eligibility',
      '2. Description of Service',
      '3. User Accounts',
      '4. Payments and Credits',
      '5. Invite & Earn Program',
      '6. Seller Payouts',
      '7. Acceptable Use',
      '8. Intellectual Property',
      '9. Disclaimer of Warranties',
      '10. Limitation of Liability',
      '11. Termination',
      '12. Changes to Terms',
      '13. Contact Us',
    ]);
    // The whole section, word for word: the owner approved this text and no other.
    const payoutsHeading = screen.getByRole('heading', { level: 2, name: '6. Seller Payouts' });
    expect(payoutsHeading.parentElement!.children).toHaveLength(2);
    expect(payoutsHeading.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim()).toBe([
      `When you sell a recipe on ${siteConfig.name}, you keep 85% of the price of every paid unlock, and we keep 15%.`,
      'Free unlocks do not earn anything.',
      'Your earnings collect in your seller balance, and you can request a payout once that balance reaches $100.',
      'Payouts are paid in Indian rupees (INR) to a UPI ID or an Indian bank account that you give us, and we send',
      'each payout within 14 days of your request.',
      'We convert your dollar balance to rupees at the exchange rate on the day we send the payout.',
      'PayPal and international transfers are not available yet.',
    ].join(' '));
    expect(screen.getByText('Last updated: October 18, 2026')).toBeInTheDocument();
  });
});
