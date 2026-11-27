import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The queue, settlement and claim SQL are real; who is told, and what the
// provider says, are observed and scripted.
const doubles = vi.hoisted(() => ({ notify: vi.fn(), sync: vi.fn() }));
vi.mock('@/lib/mobile-notifications', () => ({
  notifyGenerationStatus: (...args: unknown[]) => doubles.notify(...args),
}));
vi.mock('@/lib/completed-remix-notification', () => ({ notifyCompletedRemix: vi.fn() }));
vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatusByPredictionId: (...args: unknown[]) => doubles.sync(...args),
}));

import { GENERATION_OUTPUT_IMPORT_ABANDONED_MESSAGE, retryOrAbandonExhaustedGenerationOutputImports } from '@/lib/generation-output-import-retries';
import { reapStalledGenerations } from '@/lib/stalled-generation-reaper';

const connectionString = process.env.SUPABASE_TEST_DB_URL;
const HOUR = 60 * 60 * 1000;
const TABLES = new Set(['generations', 'generation_output_import_jobs']);
const RPCS = new Set([
  'enqueue_generation_output_import_job',
  'claim_generation_output_import_jobs',
  'finish_generation_output_import_job',
  'settle_generation_failed',
]);

function column(name: string): string {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`Unexpected column ${name}`);
  return name;
}

/**
 * The plain query surface the sweep and the reaper use, turned into SQL: no
 * embedded resources. `or` takes PostgREST's flat filter list of `col.op.value`
 * and `and(...)` groups, which is all the import sweep sends.
 */
function databaseClient(db: Client): SupabaseClient {
  return {
    from(table: string) {
      if (!TABLES.has(table)) throw new Error(`Unexpected table ${table}`);
      const where: string[] = [];
      const values: unknown[] = [];
      const orderBy: string[] = [];
      let columns = '*';
      let limit: number | undefined;
      let patch: Record<string, unknown> | undefined;
      let returning = false;
      const param = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      const ops: Record<string, string> = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' };
      const condition = (text: string): string => {
        if (text.startsWith('and(') && text.endsWith(')')) {
          return `(${split(text.slice(4, -1)).map(condition).join(' and ')})`;
        }
        const first = text.indexOf('.');
        const second = text.indexOf('.', first + 1);
        const op = ops[text.slice(first + 1, second)];
        if (!op) throw new Error(`Unexpected filter ${text}`);
        return `${column(text.slice(0, first))} ${op} ${param(text.slice(second + 1))}`;
      };
      const split = (list: string): string[] => {
        const parts: string[] = [];
        let depth = 0;
        let current = '';
        for (const char of list) {
          if (char === '(') depth += 1;
          if (char === ')') depth -= 1;
          if (char === ',' && depth === 0) {
            parts.push(current);
            current = '';
          } else current += char;
        }
        parts.push(current);
        return parts;
      };
      const run = async () => {
        if (!where.length) throw new Error('Unbounded fixture query');
        if (patch) {
          const sets = Object.entries(patch).map(([key, value]) => `${column(key)} = ${param(value)}`);
          const { rows } = await db.query(
            `update public.${table} set ${sets.join(', ')} where ${where.join(' and ')}${returning ? ' returning id' : ''}`,
            values,
          );
          return { data: returning ? rows : null, error: null };
        }
        const { rows } = await db.query(
          `select ${columns} from public.${table} where ${where.join(' and ')}`
            + (orderBy.length ? ` order by ${orderBy.join(', ')}` : '')
            + (limit ? ` limit ${limit}` : ''),
          values,
        );
        return { data: rows, error: null };
      };
      const query = {
        select: (list: string) => {
          if (patch) returning = true;
          else columns = list.split(',').map((name) => column(name.trim())).join(', ');
          return query;
        },
        update: (values: Record<string, unknown>) => {
          patch = values;
          return query;
        },
        eq: (key: string, value: unknown) => (where.push(`${column(key)} = ${param(value)}`), query),
        in: (key: string, value: unknown[]) => (where.push(`${column(key)} = any(${param(value)})`), query),
        is: (key: string) => (where.push(`${column(key)} is null`), query),
        not: (key: string) => (where.push(`${column(key)} is not null`), query),
        lt: (key: string, value: unknown) => (where.push(`${column(key)} < ${param(value)}`), query),
        or: (list: string) => (where.push(`(${split(list).map(condition).join(' or ')})`), query),
        order: (key: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => {
          orderBy.push(`${column(key)} ${options?.ascending === false ? 'desc' : 'asc'}${options?.nullsFirst ? ' nulls first' : ''}`);
          return query;
        },
        limit: (count: number) => ((limit = count), query),
        then: (yes: (value: unknown) => unknown, no: (error: unknown) => unknown) => run().then(yes, no),
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (!RPCS.has(name)) throw new Error(`Unexpected RPC ${name}`);
      const keys = Object.keys(args);
      if (!keys.every((key) => /^p_[a-z_]+$/.test(key))) throw new Error('Invalid RPC arguments');
      const call = `public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')})`;
      const setof = name === 'claim_generation_output_import_jobs';
      const { rows } = await db.query(
        setof ? `select * from ${call}` : `select ${call} result`,
        Object.values(args).map((value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value)),
      );
      return { data: setof ? rows : rows[0].result, error: null };
    },
  } as unknown as SupabaseClient;
}

describe.skipIf(!connectionString)('generation terminal states with real PostgreSQL', () => {
  let db: Client;
  let client: SupabaseClient;
  let userId: string;
  let now: number;

  beforeEach(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    doubles.notify.mockReset().mockResolvedValue(null);
    doubles.sync.mockReset();
    db = new Client({ connectionString });
    await db.connect();
    await db.query('begin');
    await db.query("set local statement_timeout='10s'");
    // The transaction's own clock: now() is fixed at its start, and the claim
    // compares the reopened next_attempt_at against it.
    now = Number((await db.query('select (extract(epoch from now()) * 1000)::bigint as ms')).rows[0].ms);
    userId = randomUUID();
    await db.query(
      "insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",
      [userId, `${userId}@example.invalid`],
    );
    await db.query('update public.profiles set credits=500 where id=$1', [userId]);
    await db.query('set local role service_role');
    client = databaseClient(db);
  });

  afterEach(async () => {
    try {
      await db?.query('rollback');
    } finally {
      await db?.end();
    }
  });

  async function seedGeneration(createdAgoMs: number, status = 'processing') {
    const id = randomUUID();
    const predictionId = `terminal-states-${randomUUID()}`;
    await db.query(
      `insert into public.generations(id,user_id,prediction_id,status,cost,category,model,prompt,refunded,created_at)
       values($1,$2,$3,$4,120,'video','veo3','terminal states fixture',false,$5)`,
      [id, userId, predictionId, status, new Date(now - createdAgoMs).toISOString()],
    );
    return { id, predictionId };
  }

  async function credits() {
    return (await db.query('select credits from public.profiles where id=$1', [userId])).rows[0].credits as number;
  }

  async function generation(id: string) {
    return (await db.query('select status, refunded, provider_sync_attempted_at from public.generations where id=$1', [id])).rows[0];
  }

  async function job(generationId: string) {
    return (await db.query(
      'select status, attempt_count from public.generation_output_import_jobs where generation_id=$1',
      [generationId],
    )).rows[0];
  }

  /** An import that used its tries: enqueued, claimed, failed with the last one. */
  async function exhaustImport(generationId: string, lastError = 'Remote media host is not allowlisted.') {
    await client.rpc('enqueue_generation_output_import_job', {
      p_generation_id: generationId,
      p_output_urls: ['https://provider.invalid/output.mp4'],
      p_provider_completed_at: new Date(now).toISOString(),
    });
    await db.query(
      'update public.generation_output_import_jobs set attempt_count = 9, next_attempt_at = now() - interval \'1 minute\' where generation_id = $1',
      [generationId],
    );
    const { data } = await client.rpc('claim_generation_output_import_jobs', {
      p_limit: 25, p_locked_by: 'terminal-states-worker', p_lock_ttl_seconds: 300,
    });
    const claimed = (data as Array<{ id: string; generation_id: string }>).find((row) => row.generation_id === generationId)!;
    const { data: outcome } = await client.rpc('finish_generation_output_import_job', {
      p_id: claimed.id, p_locked_by: 'terminal-states-worker', p_succeeded: false, p_error: lastError,
      p_retry_delay_seconds: 60, p_max_attempts: 10,
    });
    expect(outcome).toBe('exhausted');
  }

  async function ageImport(generationId: string, fields: { completedAgoMs?: number; queuedAgoMs?: number }) {
    if (fields.completedAgoMs !== undefined) {
      await db.query('update public.generation_output_import_jobs set completed_at = $2, updated_at = $2 where generation_id = $1', [
        generationId, new Date(now - fields.completedAgoMs).toISOString(),
      ]);
    }
    if (fields.queuedAgoMs !== undefined) {
      const at = new Date(now - fields.queuedAgoMs).toISOString();
      await db.query('update public.generation_output_import_jobs set created_at = $2, provider_completed_at = $2 where generation_id = $1', [
        generationId, at,
      ]);
    }
  }

  describe('an exhausted output import', () => {
    it('is left alone within the hour, then reopened once and claimed again, keeping its tries', async () => {
      const { id } = await seedGeneration(3 * HOUR);
      await exhaustImport(id);

      await ageImport(id, { completedAgoMs: 20 * 60_000 });
      expect(await retryOrAbandonExhaustedGenerationOutputImports({ client, nowMs: now }))
        .toMatchObject({ eligible: 0, reopened: 0 });
      expect(await job(id)).toEqual({ status: 'failed', attempt_count: 10 });

      await ageImport(id, { completedAgoMs: 61 * 60_000 });
      expect(await retryOrAbandonExhaustedGenerationOutputImports({ client, nowMs: now }))
        .toMatchObject({ eligible: 1, reopened: 1, abandoned: 0 });
      expect(await job(id)).toEqual({ status: 'pending', attempt_count: 10 });
      const { data } = await client.rpc('claim_generation_output_import_jobs', {
        p_limit: 25, p_locked_by: 'terminal-states-worker-2', p_lock_ttl_seconds: 300,
      });
      expect((data as Array<{ generation_id: string }>).map((row) => row.generation_id)).toContain(id);
      // The generation still holds its credits while the file may yet arrive.
      expect(await generation(id)).toMatchObject({ status: 'processing', refunded: false });
      expect(await credits()).toBe(500);
    });

    it('fails and refunds the generation once 24 hours have passed since the provider finished, once', async () => {
      const { id } = await seedGeneration(26 * HOUR);
      await exhaustImport(id);
      await ageImport(id, { completedAgoMs: 10 * 60_000, queuedAgoMs: 25 * HOUR });

      expect(await retryOrAbandonExhaustedGenerationOutputImports({ client, nowMs: now }))
        .toMatchObject({ eligible: 1, abandoned: 1, failed: 0 });
      expect(await generation(id)).toMatchObject({ status: 'failed', refunded: true });
      expect(await credits()).toBe(620);
      expect(await job(id)).toEqual({ status: 'cancelled', attempt_count: 10 });
      const message = (await db.query('select error_message from public.generations where id=$1', [id])).rows[0].error_message;
      expect(message).toBe(GENERATION_OUTPUT_IMPORT_ABANDONED_MESSAGE);
      expect(doubles.notify).toHaveBeenCalledExactlyOnceWith(client, expect.objectContaining({ id, user_id: userId }), 'failed');

      // A second pass finds nothing owed: no second refund, no second notice.
      expect(await retryOrAbandonExhaustedGenerationOutputImports({ client, nowMs: now + 10 * 60_000 }))
        .toMatchObject({ eligible: 0, abandoned: 0 });
      expect(await credits()).toBe(620);
      expect(doubles.notify).toHaveBeenCalledTimes(1);
    });

    it('ends an import whose worker died mid-run once its window has ended', async () => {
      const { id } = await seedGeneration(26 * HOUR);
      await client.rpc('enqueue_generation_output_import_job', {
        p_generation_id: id,
        p_output_urls: ['https://provider.invalid/output.mp4'],
        p_provider_completed_at: new Date(now).toISOString(),
      });
      await client.rpc('claim_generation_output_import_jobs', {
        p_limit: 25, p_locked_by: 'terminal-states-dead-worker', p_lock_ttl_seconds: 300,
      });
      await ageImport(id, { queuedAgoMs: 25 * HOUR });
      await db.query(
        "update public.generation_output_import_jobs set locked_at = now() - interval '10 minutes' where generation_id = $1",
        [id],
      );

      expect(await retryOrAbandonExhaustedGenerationOutputImports({ client, nowMs: now }))
        .toMatchObject({ abandoned: 1 });
      expect(await generation(id)).toMatchObject({ status: 'failed', refunded: true });
      expect(await credits()).toBe(620);
    });
  });

  describe('the stalled-generation reaper', () => {
    it('takes the least recently tried rows first and leaves a finished provider to the import pipeline', async () => {
      const owned = await seedGeneration(4 * HOUR);
      const b = await seedGeneration(3 * HOUR);
      const c = await seedGeneration(2 * HOUR);
      const d = await seedGeneration(HOUR);
      await client.rpc('enqueue_generation_output_import_job', {
        p_generation_id: owned.id,
        p_output_urls: ['https://provider.invalid/output.mp4'],
        p_provider_completed_at: new Date(now).toISOString(),
      });
      doubles.sync.mockImplementation(async ({ predictionId }: { predictionId: string }) => ({
        found: true, status: 'processing', generation: { prediction_id: predictionId },
      }));
      const asked = () => doubles.sync.mock.calls.map(([args]) => (args as { predictionId: string }).predictionId);

      await reapStalledGenerations({ supabase: client, creditSupabase: client, nowMs: now, syncLimit: 2 });
      expect(asked()).toEqual([b.predictionId, c.predictionId]);
      // The import-owned row is stamped too, so it rotates instead of heading every read.
      expect((await generation(owned.id)).provider_sync_attempted_at).not.toBeNull();

      doubles.sync.mockClear();
      await reapStalledGenerations({ supabase: client, creditSupabase: client, nowMs: now + 10 * 60_000, syncLimit: 2 });
      // Never tried first, then the least recently tried, never the import-owned row.
      expect(asked()).toEqual([d.predictionId, b.predictionId]);
      expect(await credits()).toBe(500);
    });

    it('fails and refunds a row the provider still reports as running after 24 hours, once', async () => {
      const old = await seedGeneration(25 * HOUR);
      const young = await seedGeneration(23 * HOUR);
      doubles.sync.mockImplementation(async ({ predictionId }: { predictionId: string }) => ({
        found: true, status: 'processing', generation: { prediction_id: predictionId },
      }));

      await expect(reapStalledGenerations({ supabase: client, creditSupabase: client, nowMs: now }))
        .resolves.toMatchObject({ providerSync: { abandoned: 1, stillActive: 1, failed: 0 } });
      expect(await generation(old.id)).toMatchObject({ status: 'failed', refunded: true });
      expect(await generation(young.id)).toMatchObject({ status: 'processing', refunded: false });
      expect(await credits()).toBe(620);
      expect(doubles.notify).toHaveBeenCalledExactlyOnceWith(client, expect.objectContaining({ id: old.id }), 'failed');

      // The failed row leaves the reaper's reads: no second refund.
      await reapStalledGenerations({ supabase: client, creditSupabase: client, nowMs: now + 10 * 60_000 });
      expect(await credits()).toBe(620);
      expect(doubles.notify).toHaveBeenCalledTimes(1);
    });
  });
});
