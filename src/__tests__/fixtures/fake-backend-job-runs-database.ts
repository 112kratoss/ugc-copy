import { vi } from 'vitest';

import { KIE_ACCOUNT_BALANCE_ENDPOINT } from '@/lib/kie-account-balance';

/**
 * `backend_job_runs` and the job-lock RPCs, in memory: enough of PostgREST for
 * the job-run ledger, the job lock and the Kie balance alert's own state reads
 * and writes, with rows stored as JSON the way the database stores them.
 */

type RunRow = Record<string, unknown> & {
  id: string;
  job_name: string;
  lock_owner: string;
  status: string;
  started_at: string;
  summary: unknown;
};

type QueryResult = { data: unknown; error: { message: string } | null };

export function createFakeBackendJobRunsDatabase(clock: { nowMs: number }) {
  const runs: RunRow[] = [];
  const locks = new Map<string, { lockedUntilMs: number; lockedBy: string }>();
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let nextId = 1;
  let failReads = false;

  const stored = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

  class Query implements PromiseLike<QueryResult> {
    private mode: 'select' | 'insert' | 'update' = 'select';
    private filters: Array<(row: RunRow) => boolean> = [];
    private orderings: Array<{ column: string; ascending: boolean }> = [];
    private limitCount: number | null = null;
    private payload: Record<string, unknown> | null = null;
    private singleRow = false;

    select() { return this; }
    insert(values: Record<string, unknown>) { this.mode = 'insert'; this.payload = values; return this; }
    update(values: Record<string, unknown>) { this.mode = 'update'; this.payload = values; return this; }
    eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
    in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
    not(column: string, operator: string, value: unknown) {
      if (operator !== 'is' || value !== null) throw new Error(`Unsupported not filter ${operator}`);
      this.filters.push((row) => row[column] !== null && row[column] !== undefined);
      return this;
    }
    order(column: string, options: { ascending?: boolean } = {}) {
      this.orderings.push({ column, ascending: options.ascending !== false });
      return this;
    }
    limit(count: number) { this.limitCount = count; return this; }
    single() { this.singleRow = true; return this; }
    maybeSingle() { this.singleRow = true; return this; }

    then<TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
    }

    private execute(): QueryResult {
      if (this.mode === 'insert') {
        const row = {
          id: `run-${nextId++}`,
          finished_at: null,
          skip_reason: null,
          error_message: null,
          summary: null,
          metadata: {},
          ...stored(this.payload),
        } as unknown as RunRow;
        runs.push(row);
        return { data: this.singleRow ? { id: row.id } : [stored(row)], error: null };
      }
      if (this.mode === 'select' && failReads) {
        return { data: null, error: { message: 'database unavailable' } };
      }
      const matching = runs.filter((row) => this.filters.every((filter) => filter(row)));
      if (this.mode === 'update') {
        for (const row of matching) Object.assign(row, stored(this.payload));
        return { data: null, error: null };
      }
      const ordered = [...matching].sort((left, right) => {
        for (const { column, ascending } of this.orderings) {
          const a = String(left[column] ?? '');
          const b = String(right[column] ?? '');
          if (a !== b) return (a < b ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      const limited = this.limitCount === null ? ordered : ordered.slice(0, this.limitCount);
      return { data: limited.map((row) => stored(row)), error: null };
    }
  }

  const client = {
    from(table: string) {
      if (table !== 'backend_job_runs') throw new Error(`Unexpected table ${table}`);
      return new Query();
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (fn === 'try_acquire_backend_job_lock') {
        const name = String(args.p_name);
        const owner = String(args.p_locked_by);
        const existing = locks.get(name);
        if (existing && existing.lockedUntilMs > clock.nowMs && existing.lockedBy !== owner) {
          return { data: false, error: null };
        }
        locks.set(name, { lockedUntilMs: clock.nowMs + Number(args.p_ttl_seconds) * 1000, lockedBy: owner });
        return { data: true, error: null };
      }
      if (fn === 'release_backend_job_lock') {
        const existing = locks.get(String(args.p_name));
        if (existing?.lockedBy === String(args.p_locked_by)) locks.delete(String(args.p_name));
        return { data: true, error: null };
      }
      if (fn === 'prune_backend_job_runs') return { data: 0, error: null };
      return { data: null, error: { message: `Unexpected rpc ${fn}` } };
    },
  };

  return {
    client,
    runs,
    locks,
    rpcCalls,
    failReads(value: boolean) {
      failReads = value;
    },
  };
}

export type FakeBalanceAnswer = number | 'network_error' | 'http_500';

/** Kie's credit endpoint and one alert receiver, behind a single fetch. */
export function createFakeKieAndAlertReceiver(receiverUrl: string) {
  const posts: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  const state = {
    balance: 5000 as FakeBalanceAnswer,
    receiverStatus: 202,
    kieCalls: 0,
  };

  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === KIE_ACCOUNT_BALANCE_ENDPOINT) {
      state.kieCalls += 1;
      const answer = state.balance;
      if (answer === 'network_error') throw new TypeError('fetch failed');
      if (answer === 'http_500') return new Response('down', { status: 500 });
      return new Response(JSON.stringify({ code: 200, msg: 'success', data: answer }), { status: 200 });
    }
    if (url === receiverUrl) {
      posts.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response('{}', { status: state.receiverStatus });
    }
    throw new Error(`Unexpected request to ${url}`);
  });

  return { posts, state, fetcher };
}
