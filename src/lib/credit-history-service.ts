import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Credit history: what added credits to a balance and what took them, newest
 * first (contract C4 of the 2026-10-15 decisions run; `GET /api/credits/history`).
 *
 * The list is built in the database by `list_credit_history`
 * (supabase/migrations/20261015174548_credit_history.sql), which reads each table
 * a credit movement leaves a record in and words every row. This module asks it
 * for one page and carries the keyset between pages as an opaque cursor.
 */

export const CREDIT_HISTORY_KINDS = ['purchase', 'grant', 'refund', 'reversal', 'spend', 'adjustment'] as const;

export type CreditHistoryKind = (typeof CREDIT_HISTORY_KINDS)[number];

export type CreditHistoryEntry = {
  id: string;
  kind: CreditHistoryKind;
  /** Signed whole credits: positive came in, negative went out. */
  amount: number;
  /** ISO 8601, UTC. */
  occurredAt: string;
  /** The server's plain words: "Creator pack", "Video generation", "Refund: failed video". */
  title: string;
  detail: string | null;
};

export type CreditHistoryPage = {
  entries: CreditHistoryEntry[];
  /** Opaque; sent back as `cursor` for the next, older page. Null on the last page. */
  nextCursor: string | null;
};

export const CREDIT_HISTORY_DEFAULT_LIMIT = 30;
export const CREDIT_HISTORY_MAX_LIMIT = 50;

/** The last entry of a page: the database pages on (occurred_at, entry id). */
export type CreditHistoryCursor = {
  /** The database's own timestamp text, microseconds and all: a JS Date keeps milliseconds and would skip or repeat rows. */
  occurredAt: string;
  id: string;
};

export type CreditHistoryQuery = {
  cursor: CreditHistoryCursor | null;
  limit: number;
};

export type CreditHistoryQueryError = {
  error: string;
  code: 'INVALID_CURSOR' | 'INVALID_LIMIT';
};

const CURSOR_VERSION = 1;
const CURSOR_MAX_LENGTH = 256;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const LIMIT_PATTERN = /^\d+$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
// 'purchase:<uuid>', 'generation:<uuid>:refund', 'purchase-adjustment:<uuid>', …
const ENTRY_ID_PATTERN = /^[a-z][a-z-]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[a-z]+)?$/;
const KIND_SET: ReadonlySet<string> = new Set(CREDIT_HISTORY_KINDS);

/**
 * A timestamp as Postgres writes one into JSON ("2026-10-15T09:10:02.087654+00:00").
 * Date.parse alone takes "February 30" and rolls it over, while Postgres refuses
 * it, so the calendar is checked too: a cursor the database would refuse is a 400
 * here rather than a 500 there.
 */
function isDatabaseTimestamp(value: string): boolean {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth
    && hour <= 23 && minute <= 59 && second <= 59;
}

export function encodeCreditHistoryCursor(cursor: CreditHistoryCursor): string {
  return Buffer
    .from(JSON.stringify({ v: CURSOR_VERSION, t: cursor.occurredAt, i: cursor.id }), 'utf8')
    .toString('base64url');
}

/** The cursor this module wrote, or null for anything else. */
export function decodeCreditHistoryCursor(value: string): CreditHistoryCursor | null {
  if (!value || value.length > CURSOR_MAX_LENGTH || !CURSOR_PATTERN.test(value)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { v, t, i } = parsed as Record<string, unknown>;
  if (v !== CURSOR_VERSION || typeof t !== 'string' || typeof i !== 'string') return null;
  if (!isDatabaseTimestamp(t)) return null;
  if (!ENTRY_ID_PATTERN.test(i)) return null;

  return { occurredAt: t, id: i };
}

/**
 * `limit` is a whole number, held to 1–50; left out (or empty) it is 30. Anything
 * that is not a whole number is refused rather than guessed at.
 */
export function parseCreditHistoryLimit(value: string | null): number | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return CREDIT_HISTORY_DEFAULT_LIMIT;
  if (!LIMIT_PATTERN.test(trimmed)) return null;
  return Math.min(CREDIT_HISTORY_MAX_LIMIT, Math.max(1, Number(trimmed)));
}

export function parseCreditHistoryQuery(
  searchParams: URLSearchParams,
): { ok: true; query: CreditHistoryQuery } | ({ ok: false } & CreditHistoryQueryError) {
  const limit = parseCreditHistoryLimit(searchParams.get('limit'));
  if (limit === null) {
    return {
      ok: false,
      code: 'INVALID_LIMIT',
      error: `limit must be a whole number from 1 to ${CREDIT_HISTORY_MAX_LIMIT}.`,
    };
  }

  const rawCursor = searchParams.get('cursor')?.trim() ?? '';
  if (!rawCursor) return { ok: true, query: { cursor: null, limit } };

  const cursor = decodeCreditHistoryCursor(rawCursor);
  if (!cursor) {
    return {
      ok: false,
      code: 'INVALID_CURSOR',
      error: 'This page of your credit history is no longer available. Reload it from the start.',
    };
  }

  return { ok: true, query: { cursor, limit } };
}

type CreditHistoryRow = {
  entry_id: string;
  kind: CreditHistoryKind;
  amount: number;
  occurred_at: string;
  title: string;
  detail: string | null;
};

function readCreditHistoryRow(value: unknown): CreditHistoryRow {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const { entry_id: entryId, kind, amount, occurred_at: occurredAt, title, detail } = row;

  // The function's columns are pinned by supabase/tests/database/credit_history.test.sql.
  // A row outside them means the database and this build disagree, and a money
  // list with a row quietly dropped would be wrong, so the page fails instead.
  if (
    typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId)
    || typeof kind !== 'string' || !KIND_SET.has(kind)
    || typeof amount !== 'number' || !Number.isInteger(amount)
    || typeof occurredAt !== 'string' || !isDatabaseTimestamp(occurredAt)
    || typeof title !== 'string' || !title.trim()
    || (detail !== null && typeof detail !== 'string')
  ) {
    throw new Error('list_credit_history returned a row outside its contract');
  }

  return {
    entry_id: entryId,
    kind: kind as CreditHistoryKind,
    amount,
    occurred_at: occurredAt,
    title,
    detail: detail === null || !detail.trim() ? null : detail,
  };
}

function toCreditHistoryEntry(row: CreditHistoryRow): CreditHistoryEntry {
  return {
    id: row.entry_id,
    kind: row.kind,
    amount: row.amount,
    occurredAt: new Date(row.occurred_at).toISOString(),
    title: row.title,
    detail: row.detail,
  };
}

/**
 * One page of the history of `userIds`: the caller first, then the guest
 * identities linked to it (`resolveLinkedAccountIds`). The database refuses any
 * other set. `client` is the service-role client: the function is closed to
 * every other role.
 */
export async function listCreditHistory({
  client,
  userIds,
  cursor,
  limit,
}: {
  client: SupabaseClient;
  userIds: string[];
  cursor: CreditHistoryCursor | null;
  limit: number;
}): Promise<CreditHistoryPage> {
  const pageLimit = Math.min(CREDIT_HISTORY_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
  const { data, error } = await client.rpc('list_credit_history', {
    p_user_ids: userIds,
    p_before_occurred_at: cursor?.occurredAt ?? null,
    p_before_id: cursor?.id ?? null,
    // One more than the page, to know whether another page follows.
    p_limit: pageLimit + 1,
  });

  // The logger keeps an Error's message and drops its cause, so the database's
  // words travel in the message.
  if (error) throw new Error(`list_credit_history failed: ${error.message}`);
  if (!Array.isArray(data)) throw new Error('list_credit_history returned no rows array');

  const rows = data.slice(0, pageLimit + 1).map(readCreditHistoryRow);
  const pageRows = rows.slice(0, pageLimit);
  const last = pageRows.at(-1);

  return {
    entries: pageRows.map(toCreditHistoryEntry),
    nextCursor: rows.length > pageLimit && last
      ? encodeCreditHistoryCursor({ occurredAt: last.occurred_at, id: last.entry_id })
      : null,
  };
}
