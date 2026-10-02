import { randomUUID, createHmac } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reapStalledGenerations,
  hasStalledGenerationWork,
} from '@/lib/stalled-generation-reaper';
import { handleKieWebhookForRoute } from '@/lib/kie-webhook-service';

// The settlement SQL is real; who is told about it is observed, not delivered.
const notifier = vi.hoisted(() => ({ notifyGenerationStatus: vi.fn() }));
vi.mock('@/lib/mobile-notifications', () => ({
  notifyGenerationStatus: (...args: unknown[]) =>
    notifier.notifyGenerationStatus(...args),
}));

// These cases stop at durable callback admission; after() workers are not run.
const connectionString = process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!connectionString)(
  'generation grace and callback admission with real PostgreSQL',
  () => {
    let db: Client;
    let userId: string;
    let generationId: string;
    let taskId: string;
    let client: SupabaseClient;
    let now: number;
    let beforeSettlement: (() => Promise<void>) | undefined;
    let markerUnavailable = false;
    let beforeMarker: (() => Promise<void>) | undefined;
    let reconciliationFault:
      | 'error'
      | 'throw'
      | 'empty'
      | 'unknown'
      | 'lost-response'
      | undefined;
    let scheduled: ReturnType<
      typeof vi.fn<(callback: () => void | Promise<void>) => void>
    >;

    beforeEach(async () => {
      expect(['localhost', '127.0.0.1']).toContain(
        new URL(connectionString!).hostname,
      );
      db = new Client({ connectionString });
      await db.connect();
      await db.query('begin');
      await db.query("set local statement_timeout='10s'");
      now = Date.now();
      userId = randomUUID();
      generationId = randomUUID();
      taskId = `audit-grace-${randomUUID()}`;
      scheduled = vi.fn();
      notifier.notifyGenerationStatus.mockReset().mockResolvedValue(null);
      beforeSettlement = undefined;
      reconciliationFault = undefined;
      markerUnavailable = false;
      beforeMarker = undefined;
      await db.query(
        "insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",
        [userId, `${userId}@example.invalid`],
      );
      await db.query(
        'update public.profiles set credits=500,promotional_credits=0 where id=$1',
        [userId],
      );
      await db.query(
        `insert into public.generations(id,user_id,status,cost,category,model,prompt,created_at,refunded,client_request_key_hash)
      values($1,$2,'pending',120,'image','nano-banana-pro','local grace recovery fixture',$3,false,$4)`,
        [
          generationId,
          userId,
          new Date(now - 46 * 60_000).toISOString(),
          'a'.repeat(64),
        ],
      );
      await db.query('set local role service_role');
      await db.query('select public.mark_generation_submission_unknown($1)', [
        generationId,
      ]);
      client = {
        from(table: string) {
          if (table !== 'generations')
            throw new Error(`Unexpected table ${table}`);
          const filters: string[] = [];
          const values: unknown[] = [];
          const columnName = (name: string) => {
            if (!['id', 'status', 'prediction_id', 'created_at'].includes(name))
              throw new Error('Unexpected column');
            return name;
          };
          const add = (column: string, op: string, value: unknown) => {
            values.push(value);
            filters.push(`${columnName(column)} ${op} $${values.length}`);
            return query;
          };
          const query = {
            select: () => query,
            eq: (column: string, value: unknown) => add(column, '=', value),
            in: (column: string, value: unknown[]) => {
              values.push(value);
              filters.push(`${columnName(column)} = any($${values.length})`);
              return query;
            },
            is: (column: string) => {
              filters.push(`${columnName(column)} is null`);
              return query;
            },
            not: (column: string) => {
              filters.push(`${columnName(column)} is not null`);
              return query;
            },
            lt: (column: string, value: unknown) => add(column, '<', value),
            order: () => query,
            limit: async (limit: number) => {
              const { rows } = await db.query(
                `select * from public.generations where ${filters.join(' and ')} order by created_at limit $${values.length + 1}`,
                [...values, limit],
              );
              return { data: rows, error: null };
            },
          };
          return query;
        },
        async rpc(name: string, args: Record<string, unknown>) {
          if (
            ![
              'mark_generation_submission_unknown',
              'attach_generation_provider_task',
              'enqueue_generation_completion_job',
              'settle_generation_start_failed',
              'record_provider_submission_reconciliation',
            ].includes(name)
          )
            throw new Error(`Unexpected RPC ${name}`);
          if (name === 'mark_generation_submission_unknown') {
            if (beforeMarker) {
              const hook = beforeMarker;
              beforeMarker = undefined;
              await hook();
            }
            if (markerUnavailable)
              return {
                data: null,
                error: new Error('synthetic marker unavailable'),
              };
          }
          if (name === 'settle_generation_start_failed' && beforeSettlement) {
            const hook = beforeSettlement;
            beforeSettlement = undefined;
            await hook();
          }
          const fault =
            name === 'record_provider_submission_reconciliation'
              ? reconciliationFault
              : undefined;
          if (fault) reconciliationFault = undefined;
          if (fault === 'throw')
            throw new Error('synthetic ledger transport outage');
          if (fault === 'error')
            return { data: null, error: new Error('synthetic ledger outage') };
          if (fault === 'empty') return { data: null, error: null };
          if (fault === 'unknown')
            return { data: { status: 'unexpected' }, error: null };
          const keys = Object.keys(args);
          if (!keys.every((key) => /^p_[a-z_]+$/.test(key)))
            throw new Error('Invalid argument');
          const { rows } = await db.query(
            `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) result`,
            Object.values(args).map((value) =>
              value !== null && typeof value === 'object'
                ? JSON.stringify(value)
                : value,
            ),
          );
          if (fault === 'lost-response')
            return {
              data: null,
              error: new Error('synthetic response lost after insert'),
            };
          return { data: rows[0].result, error: null };
        },
      } as unknown as SupabaseClient;
    });
    afterEach(async () => {
      try {
        await db?.query('rollback');
      } finally {
        await db?.end();
      }
    });
    async function state() {
      return (
        await db.query(
          `select g.status,g.prediction_id,g.refunded,g.client_request_key_hash,p.credits,
      (select count(*)::int from public.provider_submission_reconciliations where generation_id=$1) reconciliations,
      (select count(*)::int from public.generation_completion_jobs where prediction_id=$2) jobs
      from public.generations g join public.profiles p on p.id=g.user_id where g.id=$1`,
          [generationId, taskId],
        )
      ).rows[0];
    }
    async function callback() {
      const body = JSON.stringify({
        data: { taskId, state: 'success', resultJson: '{"resultUrls":[]}' },
      });
      const timestamp = String(Math.floor(now / 1000));
      const signature = createHmac('sha256', 'local-grace-hmac')
        .update(
          JSON.stringify([
            'kie-webhook-v2',
            taskId,
            timestamp,
            generationId,
            body,
          ]),
        )
        .digest('base64');
      return handleKieWebhookForRoute({
        createServiceClient: () => client,
        env: { KIE_WEBHOOK_HMAC_KEY: 'local-grace-hmac' },
        nowMs: now,
        request: new Request(
          `http://localhost/api/webhooks/kie?generationId=${generationId}`,
          {
            method: 'POST',
            body,
            headers: {
              'x-webhook-timestamp': timestamp,
              'x-webhook-payload-signature': signature,
            },
          },
        ),
        scheduleAfter: scheduled,
      });
    }
    const reap = () =>
      reapStalledGenerations({
        supabase: client,
        creditSupabase: client,
        nowMs: now,
      });

    it.each([-1, 0, 1])(
      'enforces the strict 45-minute cutoff at offset %i ms',
      async (offset) => {
        await db.query(
          'update public.generations set created_at=$2 where id=$1',
          [generationId, new Date(now - 45 * 60_000 - offset).toISOString()],
        );
        expect(await hasStalledGenerationWork(client, { nowMs: now })).toBe(
          offset > 0,
        );
        expect((await reap()).startFailures.settled).toBe(offset > 0 ? 1 : 0);
        expect(await state()).toMatchObject({
          status: offset > 0 ? 'failed' : 'pending',
          credits: offset > 0 ? 620 : 500,
          refunded: offset > 0,
        });
        expect(notifier.notifyGenerationStatus).toHaveBeenCalledTimes(
          offset > 0 ? 1 : 0,
        );
      },
    );
    it('callback after reaper selection prevents the stale refund', async () => {
      beforeSettlement = async () => {
        expect((await callback()).status).toBe(200);
      };
      expect((await reap()).startFailures).toMatchObject({
        eligible: 1,
        skipped: 1,
        settled: 0,
      });
      expect(await state()).toMatchObject({
        status: 'processing',
        prediction_id: taskId,
        credits: 500,
        refunded: false,
        jobs: 1,
        reconciliations: 0,
        client_request_key_hash: 'a'.repeat(64),
      });
      // The render is running after all: nothing failed, so nobody is told.
      expect(notifier.notifyGenerationStatus).not.toHaveBeenCalled();
    });
    it('reaper wins once, and late callback replays leave one reconciliation', async () => {
      expect((await reap()).startFailures).toMatchObject({
        settled: 1,
        submissionUnknown: 1,
      });
      expect((await reap()).startFailures.settled).toBe(0);
      expect((await callback()).status).toBe(200);
      expect((await callback()).status).toBe(200);
      expect(await state()).toMatchObject({
        status: 'failed',
        prediction_id: null,
        credits: 620,
        refunded: true,
        jobs: 0,
        reconciliations: 1,
        client_request_key_hash: null,
      });
      expect(scheduled).not.toHaveBeenCalled();
      // Told once, when the hold was released. The second reap and the late
      // callbacks settle nothing and say nothing.
      expect(notifier.notifyGenerationStatus).toHaveBeenCalledExactlyOnceWith(
        client,
        {
          id: generationId,
          user_id: userId,
          category: 'image',
          model: 'nano-banana-pro',
          // An ordinary creation: its notification opens it in the library.
          template_run_id: null,
        },
        'failed',
      );
    });
    it('closes a start whose credits had already been returned without announcing it', async () => {
      await db.query(
        'update public.generations set refunded=true where id=$1',
        [generationId],
      );
      // The settlement answers `already_failed`: it fails the row and returns
      // nothing, because nothing was still held. This run released no hold.
      expect((await reap()).startFailures.settled).toBe(1);
      expect(await state()).toMatchObject({
        status: 'failed',
        credits: 500,
        refunded: true,
      });
      expect(notifier.notifyGenerationStatus).not.toHaveBeenCalled();
    });
    it('restores an absent ambiguity marker before refund so a late callback is reconciled', async () => {
      await db.query(
        'update public.generations set submission_unknown_at=null where id=$1',
        [generationId],
      );
      expect((await reap()).startFailures.settled).toBe(1);
      expect((await callback()).status).toBe(200);
      expect(await state()).toMatchObject({
        status: 'failed',
        credits: 620,
        refunded: true,
        reconciliations: 1,
      });
    });
    it('defers an unmarked refund while its marker cannot be persisted, then recovers', async () => {
      await db.query(
        'update public.generations set submission_unknown_at=null where id=$1',
        [generationId],
      );
      markerUnavailable = true;
      expect((await reap()).startFailures.settled).toBe(0);
      expect(await state()).toMatchObject({
        status: 'pending',
        credits: 500,
        refunded: false,
      });
      markerUnavailable = false;
      expect((await reap()).startFailures.settled).toBe(1);
      expect((await callback()).status).toBe(200);
      expect(await state()).toMatchObject({
        status: 'failed',
        credits: 620,
        refunded: true,
        reconciliations: 1,
      });
    });
    it('a callback before the reaper marker prevents refund', async () => {
      await db.query(
        'update public.generations set submission_unknown_at=null where id=$1',
        [generationId],
      );
      beforeMarker = async () => {
        expect((await callback()).status).toBe(200);
      };
      expect((await reap()).startFailures).toMatchObject({
        settled: 0,
        skipped: 1,
      });
      expect(await state()).toMatchObject({
        status: 'processing',
        credits: 500,
        refunded: false,
        jobs: 1,
      });
    });

    it.each(['error', 'throw', 'empty', 'unknown', 'lost-response'] as const)(
      'retries a late callback when reconciliation returns %s',
      async (fault) => {
        await reap();
        reconciliationFault = fault;
        expect((await callback()).status).toBe(503);
        expect(await state()).toMatchObject({
          status: 'failed',
          credits: 620,
          refunded: true,
          jobs: 0,
          reconciliations: fault === 'lost-response' ? 1 : 0,
        });
        expect((await callback()).status).toBe(200);
        expect((await callback()).status).toBe(200);
        expect(await state()).toMatchObject({
          status: 'failed',
          credits: 620,
          refunded: true,
          jobs: 0,
          reconciliations: 1,
        });
        expect(scheduled).not.toHaveBeenCalled();
      },
    );
  },
);
