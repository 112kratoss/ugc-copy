/**
 * Prices the creators were quoted in the last few minutes, by the quote request
 * itself (its JSON: the model, the settings, the input facts and the catalog
 * revision). Switching a setting away and back, or between two tools whose
 * drafts are each priced, asked `/api/generation-models/quote` again for a run
 * just priced.
 *
 * A remembered price is only what the creator shows. The start prices the run
 * again, charges at most the price shown and refuses a run it prices above it
 * (`cost_changed`), before any credits are held, and a release that changes a
 * price is a new catalog revision, which is a new request. A refusal forgets
 * every price here (`forgetQuotedCosts`), and the asking that follows it, like
 * Retry quote, goes to the server.
 *
 * In memory only, for this launch; no React Native or Expo imports.
 */

export const QUOTE_MEMO_TTL_MS = 3 * 60_000;
const QUOTE_MEMO_MAX_ENTRIES = 64;

const quotedCosts = new Map<string, { costCredits: number; quotedAt: number }>();

/** The price quoted for this request less than `QUOTE_MEMO_TTL_MS` ago, or null. */
export function recallQuotedCost(key: string, now = Date.now()): number | null {
  const entry = quotedCosts.get(key);
  if (!entry) return null;
  const age = now - entry.quotedAt;
  if (age < 0 || age >= QUOTE_MEMO_TTL_MS) {
    quotedCosts.delete(key);
    return null;
  }
  return entry.costCredits;
}

export function rememberQuotedCost(key: string, costCredits: number, now = Date.now()) {
  if (!Number.isFinite(costCredits)) return;
  quotedCosts.delete(key);
  quotedCosts.set(key, { costCredits, quotedAt: now });
  while (quotedCosts.size > QUOTE_MEMO_MAX_ENTRIES) {
    quotedCosts.delete(quotedCosts.keys().next().value!);
  }
}

/** The server refused a run at its price: no price kept here is trusted again. */
export function forgetQuotedCosts() {
  quotedCosts.clear();
}
