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
    expect(screen.getByText('Last updated: October 30, 2026')).toBeInTheDocument();
  });

  // 2026-10-30: the owner chose to keep AI fan art of well-known characters public ("its ai
  // generated one and people will genarate photos like this") instead of hiding it, and asked
  // for a policy explanation. Section 8 says what such art may be used for and how a rights
  // holder complains, which is the takedown process the in-app "Stolen content" report feeds.
  it('allows AI fan art for non-commercial sharing and says how a rights holder complains', () => {
    render(<TermsOfService />);

    const section = screen.getByRole('heading', { level: 2, name: '8. Intellectual Property' }).parentElement!;
    const text = section.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain(`You may create and share this kind of fan art on ${siteConfig.name} as personal, non-commercial creative work.`);
    expect(text).toContain('do not sell it: recipes, bundles and other paid items must not feature characters, brands or works you do not have the rights to.');
    expect(text).toContain('report the post as “Stolen content” or email us at');
    expect(text).toContain('We review every complaint, remove content that infringes, and tell the person who posted it.');
    expect(text).toContain('We may close the accounts of people who repeatedly infringe.');
    expect(section.querySelector(`a[href="mailto:${siteConfig.supportEmail}"]`)).not.toBeNull();
  });
});
