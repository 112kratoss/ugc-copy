import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));

import {
  PUSH_OFFER_GAP_MS,
  PUSH_OFFER_MAX_SHOWINGS,
  parseStoredPushOffers,
  shouldOfferPush,
  withPushOfferShown,
  type StoredPushOffers,
} from '@/lib/push-prompt';

const NOW = Date.parse('2026-09-28T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const never: StoredPushOffers = { shownAt: [] };
const shownDaysAgo = (...days: number[]): StoredPushOffers => ({
  shownAt: days.map((ago) => new Date(NOW - ago * DAY).toISOString()),
});

describe('shouldOfferPush', () => {
  it.each([
    ['a signed-in person the phone can still ask', true, 'permission-required', never, true],
    ['a guest, who cannot register a token', false, 'permission-required', never, false],
    ['notifications that are already on', true, 'registered', never, false],
    ['notifications turned off for good, where the alert would not appear', true, 'denied', never, false],
    ['a build without Firebase', true, 'missing-firebase-setup', never, false],
    ['a build without a project id', true, 'missing-project-id', never, false],
    ['a platform without push', true, 'not-mobile', never, false],
    ['a push state that has not loaded yet', true, null, never, false],
    ['an offer shown three days ago', true, 'permission-required', shownDaysAgo(3), false],
    ['an offer shown eight days ago', true, 'permission-required', shownDaysAgo(8), true],
    ['three offers already shown, however long ago', true, 'permission-required', shownDaysAgo(60, 40, 20), false],
  ] as const)('%s', (_label, registered, status, stored, expected) => {
    expect(shouldOfferPush({ registered, status, stored, now: NOW })).toBe(expected);
  });

  it('waits the whole gap and no longer', () => {
    const stored = { shownAt: [new Date(NOW - PUSH_OFFER_GAP_MS).toISOString()] };
    expect(shouldOfferPush({ registered: true, status: 'permission-required', stored, now: NOW })).toBe(true);
    expect(shouldOfferPush({ registered: true, status: 'permission-required', stored, now: NOW - 1 })).toBe(false);
  });
});

describe('stored push offers', () => {
  it('reads what it writes, keeping only the latest showings', () => {
    let stored = never;
    for (let day = 0; day < PUSH_OFFER_MAX_SHOWINGS + 2; day += 1) {
      stored = withPushOfferShown(stored, NOW + day * DAY);
    }
    const reread = parseStoredPushOffers(JSON.stringify(stored));
    expect(reread.shownAt).toHaveLength(PUSH_OFFER_MAX_SHOWINGS);
    expect(reread.shownAt.at(-1)).toBe(new Date(NOW + (PUSH_OFFER_MAX_SHOWINGS + 1) * DAY).toISOString());
  });

  it.each([
    ['nothing stored', null],
    ['corrupt JSON', '{"shownAt": ['],
    ['the wrong shape', '{"shownAt": "yesterday"}'],
    ['a bare value', '42'],
  ])('treats %s as never shown', (_label, raw) => {
    expect(parseStoredPushOffers(raw)).toEqual(never);
  });

  it('drops entries that are not times', () => {
    const raw = JSON.stringify({ shownAt: ['not a date', 7, new Date(NOW).toISOString()] });
    expect(parseStoredPushOffers(raw).shownAt).toEqual([new Date(NOW).toISOString()]);
  });
});
