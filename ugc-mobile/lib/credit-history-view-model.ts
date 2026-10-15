/**
 * The Credit History screen's logic (`app/credit-history.tsx`), kept free of
 * React so it is tested without rendering. It reads the C4 answer of
 * `GET /api/credits/history` (the 2026-10-15 decisions run) the way the web's
 * `/credits` page does (`src/app/credits/credit-history.ts`): the server writes
 * every entry's words, and this only checks the shape, joins the pages and says
 * the numbers and times, so the two clients list the same rows the same way.
 */
import { formatCreditAmount } from './pricing';
import type { CreditHistoryEntry, CreditHistoryEntryKind, CreditHistoryResponse } from './types';

/** The server's default page; it takes 1 to 50. */
export const CREDIT_HISTORY_PAGE_SIZE = 30;

export const CREDIT_HISTORY_KINDS: readonly CreditHistoryEntryKind[] = [
  'purchase',
  'grant',
  'refund',
  'reversal',
  'spend',
  'adjustment',
];

/**
 * One history per identity. A guest's list and the account it later signs in
 * to are read apart; the account's answer already carries the guest's rows
 * (C4 lists every guest identity linked to the account).
 */
export function creditHistoryQueryKey(identityUserId: string | null | undefined) {
  return ['credit-history', identityUserId ?? null] as const;
}

/** The cursor for the next, older page; undefined once the last page is in. */
export function nextCreditHistoryCursor(lastPage: CreditHistoryResponse): string | undefined {
  return lastPage.nextCursor ?? undefined;
}

/** Only for an entry that arrives without words of its own; the web says the same. */
const FALLBACK_TITLES: Record<CreditHistoryEntryKind, string> = {
  purchase: 'Credit purchase',
  grant: 'Credits added',
  refund: 'Refund',
  reversal: 'Credits reversed',
  spend: 'Credits used',
  adjustment: 'Adjustment',
};

export function isCreditHistoryKind(value: unknown): value is CreditHistoryEntryKind {
  return typeof value === 'string' && (CREDIT_HISTORY_KINDS as readonly string[]).includes(value);
}

function readEntry(value: unknown): CreditHistoryEntry[] {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  // Without an id the row cannot be told apart from the next page's, and
  // without an amount it says nothing: both are left out, never guessed.
  if (typeof item.id !== 'string' || !item.id) return [];
  if (typeof item.amount !== 'number' || !Number.isFinite(item.amount)) return [];

  // A kind the server adds later is still listed, with its own title, and
  // drawn the way an adjustment is.
  const kind = isCreditHistoryKind(item.kind) ? item.kind : 'adjustment';
  const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : FALLBACK_TITLES[kind];
  const detail = typeof item.detail === 'string' && item.detail.trim() ? item.detail.trim() : null;

  return [{
    id: item.id,
    kind,
    amount: Math.round(item.amount),
    occurredAt: typeof item.occurredAt === 'string' ? item.occurredAt : '',
    title,
    detail,
  }];
}

/** Reads one page of the C4 answer; throws when it is not that shape at all. */
export function parseCreditHistoryPage(payload: unknown): CreditHistoryResponse {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { entries?: unknown }).entries)) {
    throw new Error('The credit history answer was not understood.');
  }

  const input = payload as { entries: unknown[]; nextCursor?: unknown };
  return {
    entries: input.entries.flatMap(readEntry),
    nextCursor: typeof input.nextCursor === 'string' && input.nextCursor ? input.nextCursor : null,
  };
}

/**
 * Every loaded page's rows, newest first, each entry once: a row written while
 * the reader paged could otherwise be listed twice, and the list keys rows by id.
 */
export function flattenCreditHistoryPages(pages: readonly CreditHistoryResponse[] | undefined): CreditHistoryEntry[] {
  const seen = new Set<string>();
  const entries: CreditHistoryEntry[] = [];
  for (const page of pages ?? []) {
    for (const entry of page.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  return entries;
}

const MINUS = '−';

export type CreditChangeDirection = 'in' | 'out' | 'none';

export function creditChangeDirection(amount: number): CreditChangeDirection {
  const whole = Math.round(amount);
  return whole > 0 ? 'in' : whole < 0 ? 'out' : 'none';
}

/**
 * An entry's amount with its direction, "+500" or "−120" (a true minus sign),
 * grouped as every credit figure in the app is (`formatCreditAmount`, en-IN).
 */
export function formatCreditChange(amount: number): string {
  const whole = Math.round(amount);
  if (whole === 0) return '0';
  return `${whole > 0 ? '+' : MINUS}${formatCreditAmount(Math.abs(whole))}`;
}

export function creditUnit(amount: number): 'credit' | 'credits' {
  return Math.abs(Math.round(amount)) === 1 ? 'credit' : 'credits';
}

/** The amount as a screen reader should say it: "plus 500 credits", "minus 1 credit". */
export function speakCreditChange(amount: number): string {
  const whole = Math.round(amount);
  const figure = `${formatCreditAmount(Math.abs(whole))} ${creditUnit(whole)}`;
  if (whole > 0) return `plus ${figure}`;
  if (whole < 0) return `minus ${figure}`;
  return figure;
}

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * When an entry happened, to the minute, in the reader's own locale and time
 * zone; null when the time cannot be read. Several entries a day are usual (one
 * per creation), so the date alone would not tell them apart.
 */
export function formatCreditHistoryTime(occurredAt: string, locale?: string): string | null {
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toLocaleString(locale, TIME_FORMAT);
}

/** Everything a row shows, as one label for VoiceOver and TalkBack. */
export function describeCreditHistoryEntry(entry: CreditHistoryEntry, locale?: string): string {
  return [entry.title, entry.detail, speakCreditChange(entry.amount), formatCreditHistoryTime(entry.occurredAt, locale)]
    .filter((part): part is string => Boolean(part))
    .join(', ');
}
