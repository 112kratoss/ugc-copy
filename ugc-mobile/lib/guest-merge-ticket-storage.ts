import * as SecureStore from 'expo-secure-store';

import {
  isWellFormedMergeTicket,
  type GuestMergeOutcome,
  type StoredGuestMergeTicket,
} from './guest-merge';
import type { GuestAccountMergeStatus } from './types';

/** Every ticket this device keeps, one per guest (audit 02-7, 04-8). */
const TICKETS_STORAGE_KEY = 'magicbooklet.guestMerge.tickets.v2';
/** The one ticket builds before keyed tickets kept. Read, and folded into the list at the next change. */
const LEGACY_TICKET_STORAGE_KEY = 'magicbooklet.guestMerge.ticket.v1';
/** The last link outcome, kept until the person dismisses it (audit 02-8). */
const OUTCOME_STORAGE_KEY = 'magicbooklet.guestMerge.outcome.v1';
const TICKETS_FORMAT = 2;

type TicketStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  deleteItem: (key: string) => Promise<void>;
};

const defaultStorage: TicketStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};

/** A kept outcome, with the account it was for: no other account is shown it. */
export type KeptGuestMergeOutcome = GuestMergeOutcome & { accountUserId: string };

const MERGE_STATUSES: readonly GuestAccountMergeStatus[] = [
  'merged',
  'already_merged',
  'conflict',
  'expired',
  'not_eligible',
];

// One change at a time, in the order asked for: each reads the list and writes
// it back, and two at once would lose one of them, a ticket included.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.catch(() => undefined);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function parseTicket(value: unknown): StoredGuestMergeTicket | null {
  if (!isRecord(value) || !isWellFormedMergeTicket(value.ticket)) return null;
  const guestUserId = value.guestUserId ?? null;
  const redeemedForUserId = value.redeemedForUserId ?? null;
  const expiresAt = value.expiresAt ?? null;
  if (!nullableString(guestUserId) || !nullableString(redeemedForUserId) || !nullableString(expiresAt)) return null;
  return { ticket: value.ticket, guestUserId, redeemedForUserId, expiresAt };
}

function parseTickets(stored: string | null): StoredGuestMergeTicket[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed) || !Array.isArray(parsed.tickets)) return [];
    return parsed.tickets.flatMap((entry) => parseTicket(entry) ?? []);
  } catch {
    return [];
  }
}

/**
 * The kept tickets, the legacy one included, and whether its old slot is still
 * there. Rejects when storage cannot be read: a change written over a list it
 * could not read would erase every ticket on it.
 */
async function loadTickets(storage: TicketStorage) {
  const [stored, legacy] = await Promise.all([
    storage.getItem(TICKETS_STORAGE_KEY),
    storage.getItem(LEGACY_TICKET_STORAGE_KEY),
  ]);
  const tickets = parseTickets(stored);
  if (isWellFormedMergeTicket(legacy) && !tickets.some((stored) => stored.ticket === legacy)) {
    tickets.push({ ticket: legacy, guestUserId: null, redeemedForUserId: null, expiresAt: null });
  }
  return { tickets, hasLegacySlot: legacy !== null };
}

async function saveTickets(
  storage: TicketStorage,
  tickets: readonly StoredGuestMergeTicket[],
  hasLegacySlot: boolean,
) {
  if (tickets.length > 0) {
    await storage.setItem(TICKETS_STORAGE_KEY, JSON.stringify({ format: TICKETS_FORMAT, tickets }));
  } else {
    await storage.deleteItem(TICKETS_STORAGE_KEY);
  }
  // Only once the list holds the legacy ticket (or it is spent): until then its
  // old slot is the only copy.
  if (hasLegacySlot) await storage.deleteItem(LEGACY_TICKET_STORAGE_KEY).catch(() => undefined);
}

/**
 * Every ticket kept on this device.
 *
 * Keychain/Keystore, not AsyncStorage. A ticket is a bearer secret: whoever
 * holds it can attach a guest's credits to their own account. It also has to
 * outlive app termination — that is the entire reason it exists rather than the
 * in-memory access token — so it needs durable storage that is still protected
 * at rest.
 *
 * Resolves to an empty list rather than rejecting when secure storage is
 * unavailable. A read failure at launch must not break startup; the worst case
 * is that the retry does not happen this time and the pending link waits for
 * the next one.
 */
export function readGuestMergeTickets(
  storage: TicketStorage = defaultStorage,
): Promise<StoredGuestMergeTicket[]> {
  return serialized(() => loadTickets(storage)).then(({ tickets }) => tickets, () => []);
}

/**
 * Keeps a freshly minted ticket for `guestUserId`, in place of one kept for that
 * guest that no account has been sent yet.
 *
 * Rejects when the ticket could not be kept, and the caller must not then
 * switch accounts: the guest session is the only other proof of the credits.
 */
export async function storeGuestMergeTicket(
  entry: { guestUserId: string; ticket: string; expiresAt: string | null },
  storage: TicketStorage = defaultStorage,
) {
  if (!isWellFormedMergeTicket(entry.ticket)) {
    throw new Error('Refusing to store a malformed merge ticket.');
  }
  await serialized(async () => {
    const { tickets, hasLegacySlot } = await loadTickets(storage);
    const kept = tickets.filter((stored) => (
      stored.ticket !== entry.ticket
      && !(stored.guestUserId === entry.guestUserId && stored.redeemedForUserId === null)
    ));
    kept.push({
      ticket: entry.ticket,
      guestUserId: entry.guestUserId,
      redeemedForUserId: null,
      expiresAt: entry.expiresAt,
    });
    await saveTickets(storage, kept, hasLegacySlot);
  });
}

/**
 * Records the account a ticket is about to be sent for, before it is sent: the
 * server may spend it for that account even when the answer never arrives.
 * Rejects when the record could not be made, or the ticket was sent for another
 * account, and the ticket must not be sent then (audit 04-8).
 */
export async function bindGuestMergeTicket(
  ticket: string,
  accountUserId: string,
  storage: TicketStorage = defaultStorage,
) {
  await serialized(async () => {
    const { tickets, hasLegacySlot } = await loadTickets(storage);
    const target = tickets.find((stored) => stored.ticket === ticket);
    if (!target) throw new Error('That merge ticket is no longer kept on this device.');
    if (target.redeemedForUserId === accountUserId) return;
    if (target.redeemedForUserId !== null) throw new Error('That merge ticket was sent for another account.');
    await saveTickets(
      storage,
      tickets.map((stored) => (stored === target ? { ...stored, redeemedForUserId: accountUserId } : stored)),
      hasLegacySlot,
    );
  });
}

/**
 * Forgets a ticket the server has settled. Never rejects: a ticket that cannot
 * be deleted is harmless, since it is already consumed server-side and the next
 * redemption returns already_merged or conflict.
 */
export async function removeGuestMergeTicket(ticket: string, storage: TicketStorage = defaultStorage) {
  await serialized(async () => {
    const { tickets, hasLegacySlot } = await loadTickets(storage);
    await saveTickets(storage, tickets.filter((stored) => stored.ticket !== ticket), hasLegacySlot);
  }).catch(() => undefined);
}

/**
 * Forgets every ticket the account being deleted could still redeem: its own,
 * and those not yet sent for anyone, so the next account on this phone cannot
 * take the guest credits they carry. Tickets already sent for another account
 * stay; only that account can ever redeem them. When the list cannot be read,
 * every ticket goes. Never rejects.
 */
export async function forgetGuestMergeTicketsFor(
  accountUserId: string | null,
  storage: TicketStorage = defaultStorage,
) {
  await serialized(async () => {
    try {
      const { tickets, hasLegacySlot } = await loadTickets(storage);
      await saveTickets(
        storage,
        tickets.filter((stored) => stored.redeemedForUserId !== null && stored.redeemedForUserId !== accountUserId),
        hasLegacySlot,
      );
    } catch {
      await storage.deleteItem(TICKETS_STORAGE_KEY).catch(() => undefined);
      await storage.deleteItem(LEGACY_TICKET_STORAGE_KEY).catch(() => undefined);
    }
  });
}

function parseOutcome(stored: string | null): KeptGuestMergeOutcome | null {
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value)) return null;
    const { accountUserId, status, creditsMoved, at } = value;
    if (typeof accountUserId !== 'string' || accountUserId.length === 0) return null;
    if (!MERGE_STATUSES.includes(status as GuestAccountMergeStatus)) return null;
    if (typeof creditsMoved !== 'number' || !Number.isFinite(creditsMoved) || creditsMoved < 0) return null;
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    return { accountUserId, status: status as GuestAccountMergeStatus, creditsMoved, at };
  } catch {
    return null;
  }
}

/** The outcome kept until dismissed, or null. Never rejects. */
export function readGuestMergeOutcome(
  storage: TicketStorage = defaultStorage,
): Promise<KeptGuestMergeOutcome | null> {
  return serialized(() => storage.getItem(OUTCOME_STORAGE_KEY)).then(parseOutcome, () => null);
}

/** Keeps `outcome` in place of the last one. Never rejects: the screen still shows it until the app closes. */
export async function storeGuestMergeOutcome(
  outcome: KeptGuestMergeOutcome,
  storage: TicketStorage = defaultStorage,
) {
  await serialized(() => storage.setItem(OUTCOME_STORAGE_KEY, JSON.stringify(outcome))).catch(() => undefined);
}

/** Forgets the kept outcome. Never rejects. */
export async function clearGuestMergeOutcome(storage: TicketStorage = defaultStorage) {
  await serialized(() => storage.deleteItem(OUTCOME_STORAGE_KEY)).catch(() => undefined);
}

export const GUEST_MERGE_TICKETS_STORAGE_KEY = TICKETS_STORAGE_KEY;
export const LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY = LEGACY_TICKET_STORAGE_KEY;
export { isWellFormedMergeTicket };
