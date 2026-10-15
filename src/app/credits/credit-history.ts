/**
 * The credit history read (`GET /api/credits/history`, contract C4 of the
 * 2026-10-15 decisions run): every credit added to and taken from the
 * account, newest first, a page at a time behind an opaque cursor. The
 * server writes each entry's words; this module only checks the shape,
 * joins pages and formats numbers and times. It stays free of React and of
 * the Supabase client so the page and its tests share it as it is.
 */

export const CREDIT_HISTORY_KINDS = ['purchase', 'grant', 'refund', 'reversal', 'spend', 'adjustment'] as const;

export type CreditHistoryKind = (typeof CREDIT_HISTORY_KINDS)[number];

export interface CreditHistoryEntry {
  id: string;
  kind: CreditHistoryKind;
  /** Signed whole credits: positive came in, negative went out. */
  amount: number;
  /** ISO timestamp. */
  occurredAt: string;
  /** The server's plain-English words: "Creator pack", "Video generation". */
  title: string;
  detail: string | null;
}

export interface CreditHistoryPage {
  entries: CreditHistoryEntry[];
  nextCursor: string | null;
}

/** The server's default page; it takes 1 to 50. */
export const CREDIT_HISTORY_PAGE_SIZE = 30;

export const CREDIT_HISTORY_ENDPOINT = '/api/credits/history';

/** Where a session that ended on the page signs in again, and comes back. */
export const CREDIT_HISTORY_SIGN_IN_HREF = '/login?returnUrl=/credits';

/**
 * A balance not known yet, in the words the app's "Available balance" card uses
 * (`CREDIT_BALANCE_LOADING_LABEL` in ugc-mobile/lib/pricing.ts): never a 0, which
 * reads as an empty balance to someone who has credits.
 */
export const CREDIT_BALANCE_LOADING_LABEL = 'Balance loading…';

export function creditHistoryUrl(cursor: string | null, limit = CREDIT_HISTORY_PAGE_SIZE) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return `${CREDIT_HISTORY_ENDPOINT}?${query.toString()}`;
}

/** Only for an entry that arrives without words of its own. */
const FALLBACK_TITLES: Record<CreditHistoryKind, string> = {
  purchase: 'Credit purchase',
  grant: 'Credits added',
  refund: 'Refund',
  reversal: 'Credits reversed',
  spend: 'Credits used',
  adjustment: 'Adjustment',
};

export function isCreditHistoryKind(value: unknown): value is CreditHistoryKind {
  return typeof value === 'string' && (CREDIT_HISTORY_KINDS as readonly string[]).includes(value);
}

function readEntry(value: unknown): CreditHistoryEntry[] {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  // Without an id the row cannot be told apart from the next page's, and
  // without an amount it says nothing: both are left out, never guessed.
  if (typeof item.id !== 'string' || !item.id) return [];
  if (typeof item.amount !== 'number' || !Number.isFinite(item.amount)) return [];

  // A kind added on the server later is still listed, with its own title,
  // drawn the way an adjustment is.
  const kind = isCreditHistoryKind(item.kind) ? item.kind : 'adjustment';
  const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : FALLBACK_TITLES[kind];
  const detail = typeof item.detail === 'string' && item.detail.trim() ? item.detail.trim() : null;

  return [{
    id: item.id,
    kind,
    amount: item.amount,
    occurredAt: typeof item.occurredAt === 'string' ? item.occurredAt : '',
    title,
    detail,
  }];
}

/** Reads one page of the C4 answer; throws when it is not that shape at all. */
export function parseCreditHistoryPage(payload: unknown): CreditHistoryPage {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { entries?: unknown }).entries)) {
    throw new Error('The credit history answer was not understood.');
  }

  const input = payload as { entries: unknown[]; nextCursor?: unknown };
  return {
    entries: input.entries.flatMap(readEntry),
    nextCursor: typeof input.nextCursor === 'string' && input.nextCursor ? input.nextCursor : null,
  };
}

/** An older page joined below the rows already listed, each entry once. */
export function appendCreditHistoryPage(current: CreditHistoryEntry[], older: CreditHistoryEntry[]) {
  const listed = new Set(current.map((entry) => entry.id));
  return [...current, ...older.filter((entry) => !listed.has(entry.id))];
}

/**
 * Credits are grouped in en-IN everywhere they are shown (the app's
 * `formatCreditAmount`, the server's "Credits added" push), so a number reads
 * the same on the web, in the app and in a notification.
 */
const creditNumberFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const MINUS = '−';

/** A balance as it is: a refund taken back after the credits were spent can leave it below zero. */
export function formatCreditBalance(value: number) {
  const rounded = Math.round(value);
  return `${rounded < 0 ? MINUS : ''}${creditNumberFormatter.format(Math.abs(rounded))}`;
}

/** An entry's amount with its direction: "+500", "−120". */
export function formatCreditChange(amount: number) {
  const rounded = Math.round(amount);
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : MINUS}${creditNumberFormatter.format(Math.abs(rounded))}`;
}

export function creditUnit(amount: number) {
  return Math.abs(Math.round(amount)) === 1 ? 'credit' : 'credits';
}

/** When an entry happened, in the reader's own locale; null when the time is unreadable. */
export function formatCreditHistoryTime(occurredAt: string, locale?: string) {
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}
