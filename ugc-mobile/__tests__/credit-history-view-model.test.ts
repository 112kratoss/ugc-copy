import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  CREDIT_HISTORY_KINDS,
  CREDIT_HISTORY_PAGE_SIZE,
  creditChangeDirection,
  creditHistoryQueryKey,
  creditUnit,
  describeCreditHistoryEntry,
  flattenCreditHistoryPages,
  formatCreditChange,
  formatCreditHistoryTime,
  nextCreditHistoryCursor,
  parseCreditHistoryPage,
  speakCreditChange,
} from '@/lib/credit-history-view-model';
import type { CreditHistoryEntry, CreditHistoryResponse } from '@/lib/types';

/** Midday UTC, so the calendar day is the same wherever the suite runs. */
const AT = '2026-10-15T12:00:00.000Z';

function entry(overrides: Partial<CreditHistoryEntry> = {}): CreditHistoryEntry {
  return {
    id: 'entry-1',
    kind: 'spend',
    amount: -120,
    occurredAt: AT,
    title: 'Video generation',
    detail: 'Kling 3.0',
    ...overrides,
  };
}

function page(entries: CreditHistoryEntry[], nextCursor: string | null = null): CreditHistoryResponse {
  return { entries, nextCursor };
}

describe('the C4 example in the shared contract', () => {
  const example = mobileApiContract.endpoints.getCreditHistory;

  it('reads the example page exactly as the server sends it, and its last page as the end', () => {
    const read = parseCreditHistoryPage(example.response);

    expect(read).toEqual(example.response);
    expect(nextCreditHistoryCursor(read)).toBe(example.response.nextCursor);
    expect(nextCreditHistoryCursor(parseCreditHistoryPage(example.responseVariants.lastPage))).toBeUndefined();
  });

  it('knows every kind the server lists, and asks for its default page', () => {
    expect([...CREDIT_HISTORY_KINDS]).toEqual(example.kinds);
    expect(CREDIT_HISTORY_PAGE_SIZE).toBe(example.paging.limit.default);
  });
});

describe('reading a page of the C4 answer', () => {
  it('keeps each of the six kinds, in the order the server sent them, with the cursor', () => {
    const sent = CREDIT_HISTORY_KINDS.map((kind, index) => entry({ id: `entry-${index}`, kind, amount: index % 2 ? -10 : 10 }));

    expect(parseCreditHistoryPage({ entries: sent, nextCursor: 'cursor-2' })).toEqual({ entries: sent, nextCursor: 'cursor-2' });
    expect(CREDIT_HISTORY_KINDS).toEqual(['purchase', 'grant', 'refund', 'reversal', 'spend', 'adjustment']);
  });

  it('leaves out a row with no id or no amount, rather than guessing one', () => {
    const parsed = parseCreditHistoryPage({
      entries: [
        { ...entry(), id: '' },
        { ...entry({ id: 'no-amount' }), amount: null },
        { ...entry({ id: 'not-a-number' }), amount: Number.NaN },
        { ...entry({ id: 'text-amount' }), amount: '500' },
        null,
        'entry',
        entry({ id: 'kept' }),
      ],
      nextCursor: null,
    });

    expect(parsed.entries.map((row) => row.id)).toEqual(['kept']);
  });

  it('gives a row with no words of its own the words the web gives it, and tidies the rest', () => {
    const parsed = parseCreditHistoryPage({
      entries: [
        { id: 'a', kind: 'purchase', amount: 500.4, occurredAt: AT, title: '  ', detail: '' },
        { id: 'b', kind: 'grant', amount: 100, occurredAt: AT },
        { id: 'c', kind: 'refund', amount: 60, occurredAt: AT, title: ' Refund: failed video ', detail: '  Kling 3.0  ' },
        { id: 'd', kind: 'reversal', amount: -500, occurredAt: AT, title: null },
        { id: 'e', kind: 'spend', amount: -40, occurredAt: AT, title: '' },
        { id: 'f', kind: 'adjustment', amount: 25, occurredAt: AT, title: '' },
      ],
    });

    expect(parsed.entries.map(({ id, title, detail, amount }) => ({ id, title, detail, amount }))).toEqual([
      { id: 'a', title: 'Credit purchase', detail: null, amount: 500 },
      { id: 'b', title: 'Credits added', detail: null, amount: 100 },
      { id: 'c', title: 'Refund: failed video', detail: 'Kling 3.0', amount: 60 },
      { id: 'd', title: 'Credits reversed', detail: null, amount: -500 },
      { id: 'e', title: 'Credits used', detail: null, amount: -40 },
      { id: 'f', title: 'Adjustment', detail: null, amount: 25 },
    ]);
    expect(parsed.nextCursor).toBeNull();
  });

  it('lists a kind the server adds later as an adjustment, under its own title', () => {
    const parsed = parseCreditHistoryPage({
      entries: [{ id: 'later', kind: 'payout', amount: -300, occurredAt: AT, title: 'Payout', detail: null }],
      nextCursor: '',
    });

    expect(parsed).toEqual({
      entries: [{ id: 'later', kind: 'adjustment', amount: -300, occurredAt: AT, title: 'Payout', detail: null }],
      nextCursor: null,
    });
  });

  it('keeps a row whose time cannot be read, with no time', () => {
    const [row] = parseCreditHistoryPage({ entries: [{ id: 'x', kind: 'grant', amount: 5, title: 'Welcome credits' }] }).entries;

    expect(row.occurredAt).toBe('');
    expect(formatCreditHistoryTime(row.occurredAt)).toBeNull();
  });

  it('refuses an answer that is not a page at all', () => {
    for (const payload of [null, undefined, 'entries', {}, { entries: 'none' }, { entries: null }]) {
      expect(() => parseCreditHistoryPage(payload)).toThrow('The credit history answer was not understood.');
    }
  });
});

describe('joining pages', () => {
  it('lists every page newest first, and a row the next page repeats only once', () => {
    const pages = [
      page([entry({ id: 'a' }), entry({ id: 'b' })], 'cursor-2'),
      page([entry({ id: 'b', title: 'Repeated' }), entry({ id: 'c' })]),
    ];

    const joined = flattenCreditHistoryPages(pages);
    expect(joined.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(joined[1].title).toBe('Video generation');
    expect(flattenCreditHistoryPages(undefined)).toEqual([]);
  });

  it('asks for the next page with the cursor the last one gave, and stops after the last page', () => {
    expect(nextCreditHistoryCursor(page([], 'cursor-2'))).toBe('cursor-2');
    expect(nextCreditHistoryCursor(page([]))).toBeUndefined();
    expect(CREDIT_HISTORY_PAGE_SIZE).toBe(30);
  });

  it('keeps one history per identity', () => {
    expect(creditHistoryQueryKey('guest-1')).toEqual(['credit-history', 'guest-1']);
    expect(creditHistoryQueryKey('user-1')).not.toEqual(creditHistoryQueryKey('guest-1'));
    expect(creditHistoryQueryKey(null)).toEqual(['credit-history', null]);
  });
});

describe('the amount', () => {
  it('says which way the credits moved, with a true minus sign, grouped as every credit figure is', () => {
    expect(formatCreditChange(500)).toBe('+500');
    expect(formatCreditChange(-120)).toBe('−120');
    expect(formatCreditChange(0)).toBe('0');
    expect(formatCreditChange(100000)).toBe('+1,00,000');
    expect(formatCreditChange(-2500)).toBe('−2,500');
  });

  it('reads the direction from the sign', () => {
    expect(creditChangeDirection(5)).toBe('in');
    expect(creditChangeDirection(-5)).toBe('out');
    expect(creditChangeDirection(0)).toBe('none');
  });

  it('says it in words for a screen reader, singular for one credit', () => {
    expect(speakCreditChange(500)).toBe('plus 500 credits');
    expect(speakCreditChange(-1)).toBe('minus 1 credit');
    expect(speakCreditChange(0)).toBe('0 credits');
    expect(creditUnit(1)).toBe('credit');
    expect(creditUnit(-1)).toBe('credit');
    expect(creditUnit(2)).toBe('credits');
  });
});

describe('the time and the spoken row', () => {
  it('gives the day, the month, the year and the minute', () => {
    expect(formatCreditHistoryTime(AT, 'en-GB')).toMatch(/^1[56] Oct 2026, \d{2}:\d{2}$/);
    expect(formatCreditHistoryTime('not a time')).toBeNull();
  });

  it('reads a row as one sentence: what, which, how much and when', () => {
    const time = formatCreditHistoryTime(AT, 'en-GB');

    expect(describeCreditHistoryEntry(entry(), 'en-GB')).toBe(`Video generation, Kling 3.0, minus 120 credits, ${time}`);
    expect(describeCreditHistoryEntry(entry({ kind: 'grant', amount: 100, title: 'Welcome credits', detail: null }), 'en-GB'))
      .toBe(`Welcome credits, plus 100 credits, ${time}`);
    expect(describeCreditHistoryEntry(entry({ occurredAt: '' }))).toBe('Video generation, Kling 3.0, minus 120 credits');
  });
});
