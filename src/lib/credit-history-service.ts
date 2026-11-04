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
  // The message names the fields that broke and the source prefix of the entry
  // id ("purchase", "grant"), never values, so the route's log says where to look.
  const broken = [
    typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId) ? 'entry_id' : null,
    typeof kind !== 'string' || !KIND_SET.has(kind) ? 'kind' : null,
    typeof amount !== 'number' || !Number.isInteger(amount) ? 'amount' : null,
    typeof occurredAt !== 'string' || !isDatabaseTimestamp(occurredAt) ? 'occurred_at' : null,
    typeof title !== 'string' || !title.trim() ? 'title' : null,
    detail !== null && typeof detail !== 'string' ? 'detail' : null,
  ].filter((field): field is string => field !== null);

  if (broken.length > 0) {
    const source = typeof entryId === 'string' ? /^[a-z][a-z-]{0,39}(?=:)/.exec(entryId)?.[0] : undefined;
    throw new Error(
      `list_credit_history returned a row outside its contract (${broken.join(', ')}; source ${source ?? 'unknown'})`,
    );
  }

  // Every field was checked above; the list form of the check does not narrow.
  const text = detail as string | null;
  return {
    entry_id: entryId as string,
    kind: kind as CreditHistoryKind,
    amount: amount as number,
    occurred_at: occurredAt as string,
    title: title as string,
    detail: text === null || !text.trim() ? null : text,
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

/** list_credit_history refuses a set of more than 100 ids, the account's own included. */
export const CREDIT_HISTORY_IDS_PER_CALL = 100;

/**
 * The sets one page is read in: each starts with the account, as the database
 * requires, and carries up to 99 of its linked guests. One set in the common case.
 * An account can collect more guests than that (one signed in from a fresh guest
 * session 156 times by 2026-11-04), and the whole set used to fail the page.
 */
function splitIdentitySet(userIds: string[]): string[][] {
  const [accountId, ...linked] = userIds;
  if (linked.length < CREDIT_HISTORY_IDS_PER_CALL) return [userIds];

  const sets: string[][] = [];
  for (let start = 0; start < linked.length; start += CREDIT_HISTORY_IDS_PER_CALL - 1) {
    sets.push([accountId, ...linked.slice(start, start + CREDIT_HISTORY_IDS_PER_CALL - 1)]);
  }
  return sets;
}

/**
 * Newest first, then by entry id in byte order: the database's own order
 * (`occurred_at DESC, entry_id COLLATE "C" DESC`). Times compare to the
 * microsecond, which a JS Date would drop.
 */
function compareNewestFirst(a: CreditHistoryRow, b: CreditHistoryRow): number {
  const [aSeconds, aMicros] = timestampKey(a.occurred_at);
  const [bSeconds, bMicros] = timestampKey(b.occurred_at);
  if (aSeconds !== bSeconds) return bSeconds - aSeconds;
  if (aMicros !== bMicros) return bMicros - aMicros;
  if (a.entry_id === b.entry_id) return 0;
  return a.entry_id < b.entry_id ? 1 : -1;
}

function timestampKey(value: string): [number, number] {
  const fraction = /\.(\d{1,6})/.exec(value)?.[1] ?? '';
  return [Date.parse(value.replace(/\.\d{1,6}/, '')), Number(fraction.padEnd(6, '0'))];
}

async function readCreditHistoryRows(
  client: SupabaseClient,
  userIds: string[],
  cursor: CreditHistoryCursor | null,
  rowLimit: number,
): Promise<CreditHistoryRow[]> {
  const { data, error } = await client.rpc('list_credit_history', {
    p_user_ids: userIds,
    p_before_occurred_at: cursor?.occurredAt ?? null,
    p_before_id: cursor?.id ?? null,
    p_limit: rowLimit,
  });

  // The logger keeps an Error's message and drops its cause, so the database's
  // words travel in the message.
  if (error) throw new Error(`list_credit_history failed: ${error.message}`);
  if (!Array.isArray(data)) throw new Error('list_credit_history returned no rows array');

  return data.slice(0, rowLimit).map(readCreditHistoryRow);
}

/**
 * One page of the history of `userIds`: the caller first, then the guest
 * identities linked to it (`resolveLinkedAccountIds`). The database refuses any
 * other set. `client` is the service-role client: the function is closed to
 * every other role.
 *
 * A set larger than one call takes is read in several, each the account plus a
 * share of its guests, and merged: every call answers the same keyset with its
 * own newest rows, so the newest of all of them is the page. The account's own
 * rows come back from every call and are kept once.
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
  // One more than the page, to know whether another page follows.
  const rowLimit = pageLimit + 1;

  const sets = splitIdentitySet(userIds);
  const answers = await Promise.all(sets.map((set) => readCreditHistoryRows(client, set, cursor, rowLimit)));

  let rows = answers[0];
  if (answers.length > 1) {
    const byId = new Map<string, CreditHistoryRow>();
    for (const answer of answers) {
      for (const entry of answer) byId.set(entry.entry_id, entry);
    }
    rows = [...byId.values()].sort(compareNewestFirst).slice(0, rowLimit);
  }

  const pageRows = rows.slice(0, pageLimit);
  const last = pageRows.at(-1);

  return {
    entries: pageRows.map(toCreditHistoryEntry),
    nextCursor: rows.length > pageLimit && last
      ? encodeCreditHistoryCursor({ occurredAt: last.occurred_at, id: last.entry_id })
      : null,
  };
}
