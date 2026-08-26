import { describe, expect, it } from 'vitest';

import { formatCreditAmount } from '../lib/pricing';

describe('credit amount formatting', () => {
  it('groups a long balance so it reads at a glance', () => {
    // The home header used to render this raw, as "26863".
    expect(formatCreditAmount(26863)).toBe('26,863');
  });

  it('leaves small balances alone', () => {
    expect(formatCreditAmount(500)).toBe('500');
  });

  it('treats a missing balance as zero rather than printing undefined', () => {
    expect(formatCreditAmount(null)).toBe('0');
    expect(formatCreditAmount(undefined)).toBe('0');
  });

  it('never shows a negative balance', () => {
    expect(formatCreditAmount(-40)).toBe('0');
  });

  it('drops fractional credits instead of showing a decimal balance', () => {
    expect(formatCreditAmount(12.7)).toBe('12');
  });
});
