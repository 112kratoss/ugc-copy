import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Admission/telemetry and the provider are external boundaries. Reservation,
// idempotency, locks, attachment, refund and callback admission use real SQL.
vi.mock('@/lib/provider-admission', async (original) => ({
  ...(await original<typeof import('@/lib/provider-admission')>()),
  admitProviderSubmission: vi.fn(),
  recordProviderSubmissionOutcome: vi.fn(),
}));
const connectionString = process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!connectionString)(
  'generation start recovery with real PostgreSQL',
  () => {
    let pool: Pool;
    let userId: string;
    let templateId: string | undefined;
    let client: SupabaseClient;
    let provider: ReturnType<typeof vi.fn<typeof fetch>>;
    let start: typeof import('@/lib/generation-services').startImageGeneration;
    let idempotent: typeof import('@/lib/generation-start-idempotency').withGenerationStartIdempotency;
    let publicFailure: typeof import('@/lib/generation-services').getPublicGenerationStartFailure;
    let releaseProvider: (() => void) | undefined;

    beforeEach(async () => {
      expect(['localhost', '127.0.0.1']).toContain(
        new URL(connectionString!).hostname,
      );
      vi.stubEnv('KIE_AI_API_KEY', 'local-start-test');
      vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'local-start-hmac');
      vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'local-start-provider-secret');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://local-start.invalid');
      vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'code');
      vi.resetModules();
      ({
        startImageGeneration: start,
        getPublicGenerationStartFailure: publicFailure,
      } = await import('@/lib/generation-services'));
      ({ withGenerationStartIdempotency: idempotent } = await import(
        '@/lib/generation-start-idempotency'
      ));
      provider = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({
            code: 200,
            data: { taskId: `audit-start-${userId}` },
          }),
        );
      vi.stubGlobal('fetch', provider);
      pool = new Pool({ connectionString, max: 20, statement_timeout: 10_000 });
      userId = randomUUID();
      templateId = undefined;
      releaseProvider = undefined;
      await pool.query(
        "insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",
        [userId, `${userId}@example.invalid`],
      );
      await pool.query(
        'update public.profiles set credits=500,promotional_credits=0 where id=$1',
        [userId],
      );
      client = {
        from(table: string) {
          if (!['generations', 'profiles'].includes(table))
            throw new Error(`Unexpected table ${table}`);
          const filters: string[] = [];
          const values: unknown[] = [];
          const query = {
            select: () => query,
            eq(column: string, value: unknown) {
              if (
                !['id', 'user_id', 'client_request_key_hash'].includes(column)
              )
                throw new Error('Unexpected filter');
              values.push(value);
              filters.push(`${column}=$${values.length}`);
              return query;
            },
            async maybeSingle() {
              const { rows } = await pool.query(
                `select * from public.${table} where ${filters.join(' and ')}`,
                values,
              );
              expect(rows.length).toBeLessThanOrEqual(1);
              return { data: rows[0] ?? null, error: null };
            },
          };
          return query;
        },
        async rpc(name: string, args: Record<string, unknown>) {
          if (
            ![
              'start_generation',
              'start_template_generation',
              'settle_template_generation_start_failed',
              'mark_generation_submission_unknown',
              'settle_generation_start_failed',
              'attach_generation_provider_task',
              'claim_generation_start_request',
              'try_acquire_backend_job_lock',
              'release_backend_job_lock',
              'enqueue_generation_completion_job',
              'record_provider_submission_reconciliation',
            ].includes(name)
          )
            throw new Error(`Unexpected RPC ${name}`);
          const keys = Object.keys(args);
          if (!keys.every((key) => /^p_[a-z_]+$/.test(key)))
            throw new Error('Unexpected argument');
          const db = await pool.connect();
          try {
            await db.query('begin');
            await db.query('set local role service_role');
            const { rows } = await db.query(
              `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) result`,
              Object.values(args).map((value) =>
                value !== null && typeof value === 'object'
                  ? JSON.stringify(value)
                  : value,
              ),
            );
            await db.query('commit');
            return { data: rows[0].result, error: null };
          } catch (error) {
            await db.query('rollback');
            throw error;
          } finally {
            db.release();
          }
        },
      } as unknown as SupabaseClient;
    });
    afterEach(async () => {
      releaseProvider?.();
      try {
        await pool?.query(
          'delete from public.generation_completion_jobs where prediction_id=$1',
          [`audit-start-${userId}`],
        );
        await pool?.query(
          'delete from public.backend_job_locks where name like $1',
          [`generation-start:${userId}:%`],
        );
        await pool?.query('delete from public.generations where user_id=$1', [
          userId,
        ]);
        if (templateId) {
          await pool.query(
            'delete from public.template_runs where template_id=$1',
            [templateId],
          );
          await pool.query('delete from public.templates where id=$1', [
            templateId,
          ]);
        }
        await pool?.query('delete from auth.users where id=$1', [userId]);
      } finally {
        await pool?.end();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
      }
    });
    const submit = (requestHash = 'b'.repeat(64)) =>
      idempotent({
        client,
        userId,
        idempotencyKey: 'same-start',
        requestHash,
        owner: randomUUID(),
        start: (keyHash) =>
          start({
            supabase: client,
            creditSupabase: client,
            userId,
            clientRequestKeyHash: keyHash,
            model: 'nano-banana-2',
            prompt: 'A ceramic bowl.',
            quotedCostCredits: 120,
            persistInputMedia: false,
          }),
      });
    async function rows() {
      return (
        await pool.query(
          'select status,prediction_id,cost,refunded,submission_unknown_at,client_request_key_hash,id from public.generations where user_id=$1',
          [userId],
        )
      ).rows;
    }
    const credits = async () =>
      (
        await pool.query('select credits from public.profiles where id=$1', [
          userId,
        ])
      ).rows[0].credits;
    async function callback(generationId: string) {
      const { handleKieWebhookForRoute } = await import(
        '@/lib/kie-webhook-service'
      );
      const taskId = `audit-start-${userId}`;
      const body = JSON.stringify({
        data: { taskId, state: 'success', resultJson: '{"resultUrls":[]}' },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', 'local-start-hmac')
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
        env: { KIE_WEBHOOK_HMAC_KEY: 'local-start-hmac' },
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
        scheduleAfter: () => {},
      });
    }

    it('twenty concurrent same-key starts create one provider task and one hold', async () => {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      provider.mockImplementation(async () => {
        entered();
        await barrier;
        return Response.json({
          code: 200,
          data: { taskId: `audit-start-${userId}` },
        });
      });
      const winner = submit();
      await Promise.race([started, winner]);
      try {
        const losers = await Promise.allSettled(
          Array.from({ length: 19 }, () => submit()),
        );
        expect(
          losers.every(
            (result) =>
              result.status === 'rejected' &&
              result.reason.code === 'GENERATION_START_IN_PROGRESS',
          ),
        ).toBe(true);
        expect(provider).toHaveBeenCalledTimes(1);
        expect(await credits()).toBe(380);
      } finally {
        releaseProvider?.();
      }
      await expect(winner).resolves.toMatchObject({
        remainingCredits: 380,
        cost: 120,
      });
      await expect(submit()).resolves.toMatchObject({
        idempotentReplay: true,
        predictionId: `audit-start-${userId}`,
      });
      expect(await rows()).toHaveLength(1);
      expect(provider).toHaveBeenCalledTimes(1);
      await expect(submit('c'.repeat(64))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });

    it.each([
      ['malformed JSON', '{'],
      ['null body', 'null'],
      ['missing code', '{}'],
      ['missing data', '{"code":200}'],
      ['missing task ID', '{"code":200,"data":{}}'],
      ['blank task ID', '{"code":200,"data":{"taskId":"  "}}'],
      ['numeric task ID', '{"code":200,"data":{"taskId":42}}'],
    ])(
      'holds an accepted submission with %s until its callback attaches',
      async (_name, body) => {
        provider.mockImplementation(
          async () =>
            new Response(body, {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        );
        const failure = await submit().catch((error: unknown) => error);
        expect(publicFailure(failure).code).toBe('submission_pending');
        const [generation] = await rows();
        expect(generation).toMatchObject({
          status: 'pending',
          prediction_id: null,
          refunded: false,
        });
        expect(generation.submission_unknown_at).not.toBeNull();
        expect(generation.client_request_key_hash).not.toBeNull();
        expect(await credits()).toBe(380);
        await expect(submit()).rejects.toMatchObject({
          code: 'GENERATION_START_IN_PROGRESS',
        });
        expect(provider).toHaveBeenCalledTimes(1);
        expect((await callback(generation.id)).status).toBe(200);
        await expect(submit()).resolves.toMatchObject({
          idempotentReplay: true,
          predictionId: `audit-start-${userId}`,
        });
        expect(await credits()).toBe(380);
        expect(await rows()).toHaveLength(1);
        expect(provider).toHaveBeenCalledTimes(1);
      },
    );

    it.each([true, false])(
      'callback arriving before the creation response preserves one hold (complete response: %s)',
      async (complete) => {
        provider.mockImplementation(async () => {
          const [generation] = await rows();
          expect((await callback(generation.id)).status).toBe(200);
          return complete
            ? Response.json({
                code: 200,
                data: { taskId: `audit-start-${userId}` },
              })
            : new Response('{');
        });
        const result = await submit().catch((error: unknown) => error);
        if (complete)
          expect(result).toMatchObject({
            predictionId: `audit-start-${userId}`,
          });
        else expect(publicFailure(result).code).toBe('submission_pending');
        expect(await rows()).toMatchObject([
          {
            status: 'processing',
            refunded: false,
            prediction_id: `audit-start-${userId}`,
          },
        ]);
        await expect(submit()).resolves.toMatchObject({
          idempotentReplay: true,
        });
        expect(await credits()).toBe(380);
        expect(provider).toHaveBeenCalledTimes(1);
      },
    );

    it('holds a lost provider creation response and replays after callback', async () => {
      provider.mockRejectedValue(new TypeError('fetch failed'));
      const error = await submit().catch((error: unknown) => error);
      expect(publicFailure(error).code).toBe('submission_pending');
      const [generation] = await rows();
      expect((await callback(generation.id)).status).toBe(200);
      await expect(submit()).resolves.toMatchObject({ idempotentReplay: true });
      expect(await credits()).toBe(380);
      expect(provider).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
      'template reservations recover incomplete receipts (explicit rejection: %s)',
      async (rejected) => {
        templateId = randomUUID();
        const runId = randomUUID(),
          stepId = randomUUID();
        await pool.query(
          "insert into public.templates(id,name,creator_user_id,status,is_active) values($1,'Start recovery fixture',$2,'draft',true)",
          [templateId, userId],
        );
        await pool.query(
          `insert into public.template_runs(id,template_id,user_id,graph_snapshot,graph_hash,input_manifest,input_storage_paths,output_node_id,output_kind,status,estimated_total_credits,estimated_remaining_credits)
      values($1,$2,$3,'{"version":1,"nodes":[],"edges":[]}',repeat('a',64),'[]','{}','output','image','collecting_inputs',120,120)`,
          [runId, templateId, userId],
        );
        await pool.query(
          "insert into public.template_run_steps(id,run_id,node_id,kind,media_kind,label,status,estimated_credits) values($1,$2,'image','generation','image','Image','queued',120)",
          [stepId, runId],
        );
        const input = {
          supabase: client,
          creditSupabase: client,
          userId,
          model: 'nano-banana-2' as const,
          prompt: 'A ceramic bowl.',
          quotedCostCredits: 120,
          persistInputMedia: false,
          privateRecipe: true,
          templateContext: { runId, stepId },
          clientRequestKeyHash: 'd'.repeat(64),
        };
        provider.mockImplementation(async () =>
          rejected
            ? Response.json({ code: 422, msg: 'Invalid request' })
            : new Response('{'),
        );
        const error = await start(input).catch((error: unknown) => error);
        const [generation] = await rows();
        if (rejected) {
          expect(generation).toMatchObject({
            status: 'failed',
            refunded: true,
          });
          expect(await credits()).toBe(500);
        } else {
          expect(publicFailure(error).code).toBe('submission_pending');
          expect(generation).toMatchObject({
            status: 'pending',
            refunded: false,
          });
          expect((await callback(generation.id)).status).toBe(200);
          await expect(start(input)).resolves.toMatchObject({
            idempotentReplay: true,
            predictionId: `audit-start-${userId}`,
          });
          expect(await credits()).toBe(380);
        }
        expect(provider).toHaveBeenCalledTimes(1);
      },
    );

    it('still refunds an explicit provider body rejection', async () => {
      provider.mockImplementation(async () =>
        Response.json({ code: 422, msg: 'Invalid request' }),
      );
      await expect(submit()).rejects.toThrow('Invalid request');
      expect(await rows()).toMatchObject([
        { status: 'failed', refunded: true, prediction_id: null },
      ]);
      expect(await credits()).toBe(500);
    });
  },
);
