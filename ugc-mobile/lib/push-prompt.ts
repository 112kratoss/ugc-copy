import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import type { MobilePushRegistrationResult } from './notifications';

/**
 * When the app offers notifications of its own accord: while a creation runs,
 * and after a post is published. The OS permission belongs to the install, not
 * the account, so the history does too.
 */
export const PUSH_OFFER_STORAGE_KEY = 'magicbooklet.push-offer.v1';

/** After an offer is shown, the next one waits at least this long. */
export const PUSH_OFFER_GAP_MS = 7 * 24 * 60 * 60 * 1000;

/** Offers shown before the app stops offering; the Alerts screen keeps its Enable. */
export const PUSH_OFFER_MAX_SHOWINGS = 3;

export type StoredPushOffers = {
  /** ISO times of the most recent showings, oldest first. */
  shownAt: string[];
};

const NO_OFFERS: StoredPushOffers = { shownAt: [] };

export function parseStoredPushOffers(raw: string | null): StoredPushOffers {
  if (!raw) return NO_OFFERS;
  try {
    const parsed: unknown = JSON.parse(raw);
    const shownAt = parsed && typeof parsed === 'object' ? (parsed as { shownAt?: unknown }).shownAt : null;
    if (!Array.isArray(shownAt)) return NO_OFFERS;
    return {
      shownAt: shownAt
        .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
        .slice(-PUSH_OFFER_MAX_SHOWINGS),
    };
  } catch {
    return NO_OFFERS;
  }
}

/**
 * Only a signed-in person whose phone can still show the system alert is
 * offered. `permission-required` rules out notifications already on, turned
 * off for good (`denied`: the alert would not appear, so the tap would do
 * nothing), a build that cannot deliver push, and a guest, who cannot
 * register a token at all.
 */
export function shouldOfferPush({
  registered,
  status,
  stored,
  now,
}: {
  registered: boolean;
  status: MobilePushRegistrationResult['status'] | null;
  stored: StoredPushOffers;
  now: number;
}) {
  if (!registered || status !== 'permission-required') return false;
  if (stored.shownAt.length >= PUSH_OFFER_MAX_SHOWINGS) return false;
  const lastShownAt = stored.shownAt.at(-1);
  return !lastShownAt || now - Date.parse(lastShownAt) >= PUSH_OFFER_GAP_MS;
}

export function withPushOfferShown(stored: StoredPushOffers, now: number): StoredPushOffers {
  return { shownAt: [...stored.shownAt, new Date(now).toISOString()].slice(-PUSH_OFFER_MAX_SHOWINGS) };
}

let cached: StoredPushOffers | null = null;
let hydration: Promise<StoredPushOffers> | null = null;
// Occasions already offered this session. A creation's workspace can be
// minimized and reopened, and the reopened card is the same offer: it must
// neither count as a second showing nor be hidden by the one it just made.
const offeredOccasions = new Set<string>();

function hydratePushOffers() {
  hydration ??= Promise.resolve()
    .then(() => AsyncStorage.getItem(PUSH_OFFER_STORAGE_KEY))
    .then(parseStoredPushOffers)
    .catch(() => NO_OFFERS)
    .then((stored) => {
      cached ??= stored;
      return cached;
    });
  return hydration;
}

function recordPushOfferShown(occasion: string, now: number) {
  offeredOccasions.add(occasion);
  cached = withPushOfferShown(cached ?? NO_OFFERS, now);
  const next = JSON.stringify(cached);
  void Promise.resolve()
    .then(() => AsyncStorage.setItem(PUSH_OFFER_STORAGE_KEY, next))
    .catch(() => undefined);
}

export function resetPushOffersForTests() {
  cached = null;
  hydration = null;
  offeredOccasions.clear();
}

/**
 * Whether to show the offer for one occasion, such as `creation:<startedAt>`
 * or `post:<id>`. It is decided once, as soon as the history and the device's
 * push state are both known, and holds for the rest of the session.
 */
export function usePushOffer({
  occasion,
  registered,
  status,
}: {
  occasion: string;
  registered: boolean;
  status: MobilePushRegistrationResult['status'] | null;
}) {
  const [stored, setStored] = useState<StoredPushOffers | null>(null);
  const [offered, setOffered] = useState<boolean | null>(() => (offeredOccasions.has(occasion) ? true : null));

  useEffect(() => {
    let active = true;
    void hydratePushOffers().then((value) => {
      if (active) setStored(value);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (offered !== null || !stored || status === null) return;
    const now = Date.now();
    // The module's copy, not this hook's: another offer may have been shown
    // since this one loaded the history.
    const offer = shouldOfferPush({ registered, status, stored: cached ?? stored, now });
    if (offer) recordPushOfferShown(occasion, now);
    setOffered(offer);
  }, [occasion, offered, registered, status, stored]);

  return offered === true;
}
