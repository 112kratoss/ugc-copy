import * as SecureStore from 'expo-secure-store';

import { isWellFormedMergeTicket } from './guest-merge';

const TICKET_STORAGE_KEY = 'magicbooklet.guestMerge.ticket.v1';

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

/**
 * Keychain/Keystore, not AsyncStorage.
 *
 * The ticket is a bearer secret: whoever holds it can attach this device's guest
 * credits to their own account. It also has to outlive app termination — that is
 * the entire reason it exists rather than the in-memory access token — so it
 * needs durable storage that is still protected at rest.
 */
export async function storeGuestMergeTicket(
  ticket: string,
  storage: TicketStorage = defaultStorage,
) {
  if (!isWellFormedMergeTicket(ticket)) {
    throw new Error('Refusing to store a malformed merge ticket.');
  }
  await storage.setItem(TICKET_STORAGE_KEY, ticket);
}

/**
 * Returns null rather than throwing when secure storage is unavailable.
 *
 * A read failure at launch must not break startup; the worst case is that the
 * retry does not happen this time and the pending link waits for the next one.
 */
export async function readGuestMergeTicket(
  storage: TicketStorage = defaultStorage,
): Promise<string | null> {
  try {
    const stored = await storage.getItem(TICKET_STORAGE_KEY);
    return isWellFormedMergeTicket(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Only ever called for a settled outcome. Clearing a ticket that is merely
 * un-redeemed-so-far would strand the guest's credits permanently, since the
 * secret exists nowhere else.
 */
export async function clearGuestMergeTicket(storage: TicketStorage = defaultStorage) {
  try {
    await storage.deleteItem(TICKET_STORAGE_KEY);
  } catch {
    // A ticket that cannot be deleted is harmless: it is already consumed
    // server-side, so the next redemption returns already_merged or conflict.
  }
}

export const GUEST_MERGE_TICKET_STORAGE_KEY = TICKET_STORAGE_KEY;
export { isWellFormedMergeTicket };
