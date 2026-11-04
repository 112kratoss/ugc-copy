import { afterEach, describe, expect, it } from 'vitest';

import { QUOTE_MEMO_TTL_MS, forgetQuotedCosts, recallQuotedCost, rememberQuotedCost } from '../lib/quote-memo';

afterEach(() => {
  forgetQuotedCosts();
});

describe('prices the creators were quoted lately', () => {
  it('gives back a price for the same request for three minutes, and nothing for another', () => {
    const at = 1_700_000_000_000;
    rememberQuotedCost('{"modelId":"a"}', 12, at);

    expect(recallQuotedCost('{"modelId":"a"}', at + QUOTE_MEMO_TTL_MS - 1)).toBe(12);
    expect(recallQuotedCost('{"modelId":"b"}', at)).toBeNull();
    expect(recallQuotedCost('{"modelId":"a"}', at + QUOTE_MEMO_TTL_MS)).toBeNull();
    // A clock set back never makes a price last longer.
    rememberQuotedCost('{"modelId":"a"}', 12, at);
    expect(recallQuotedCost('{"modelId":"a"}', at - 1)).toBeNull();
    expect(QUOTE_MEMO_TTL_MS).toBe(3 * 60_000);
  });

  it('forgets every price once the server refuses one, and keeps the last 64 requests', () => {
    const at = 1_700_000_000_000;
    for (let index = 0; index < 70; index += 1) rememberQuotedCost(`run-${index}`, index, at);
    expect(recallQuotedCost('run-5', at)).toBeNull();
    expect(recallQuotedCost('run-69', at)).toBe(69);

    forgetQuotedCosts();
    expect(recallQuotedCost('run-69', at)).toBeNull();
  });
});
