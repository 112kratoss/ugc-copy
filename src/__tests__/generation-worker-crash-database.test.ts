import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only media transport/preview boundaries are replaced. Processors, staging,
// notification dedupe, reservation, leases and settlement run their real code.
vi.mock('@/lib/remote-media-security', async (original) => ({
  ...(await original<typeof import('@/lib/remote-media-security')>()),
  openAllowlistedRemoteMedia: async () => ({
    body: new Response('isolated worker media bytes').body!,
    contentType: 'image/png',
    contentLength: null,
    sourceName: 'output.png',
  }),
}));
vi.mock('@/lib/generation-video-preview', () => ({
  createGenerationVideoPosterFromFile: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/generation-media-preview', () => ({
  createGenerationImagePreviewFromFile: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/provider-admission', async (original) => ({
  ...(await original<typeof import('@/lib/provider-admission')>()),
  admitProviderSubmission: vi.fn(),
  recordProviderSubmissionOutcome: vi.fn(),
}));

type WorkerMode = 'completion' | 'import' | 'start' | 'callback' | 'reap';
const connectionString = process.env.SUPABASE_TEST_DB_URL;
const workerMode = process.env.AUDIT_CRASH_WORKER;
const fixtureFile = 'src/__tests__/generation-worker-crash-database.test.ts';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function barrier(point: string) {
  if (process.env.AUDIT_CRASH_POINT !== point) return;
  await writeFile(
    join(process.env.AUDIT_CRASH_DIRECTORY!, 'barrier.json'),
    JSON.stringify({ point, pid: process.pid }),
  );
  // Real process death interrupts this wait. No exception simulates the crash.
  await new Promise(() => setInterval(() => {}, 1000));
}

async function databaseClient(db: Client): Promise<SupabaseClient> {
  await db.query('set role service_role');
  const rpcNames = new Set([
    'start_generation',
    'claim_generation_start_request',
    'try_acquire_backend_job_lock',
    'release_backend_job_lock',
    'attach_generation_provider_task',
    'enqueue_generation_completion_job',
    'mark_generation_submission_unknown',
    'settle_generation_start_failed',
    'record_provider_submission_reconciliation',
    'claim_generation_completion_jobs',
    'finish_generation_completion_job',
    'enqueue_generation_output_import_job',
    'claim_generation_output_import_jobs',
    'finish_generation_output_import_job',
    'settle_generation_succeeded',
    'settle_generation_failed',
  ]);
  return {
    from(table: string) {
      if (
        ![
          'generations',
          'profiles',
          'mobile_notifications',
          'mobile_notification_preferences',
          'mobile_push_tokens',
          'completed_post_remixes',
        ].includes(table)
      )
        throw new Error(`Unexpected table ${table}`);
      const filters: string[] = [],
        values: unknown[] = [];
      let insert: Record<string, unknown> | undefined;
      let limit: number | undefined;
      const run = async (single: boolean) => {
        if (table === 'completed_post_remixes')
          return { data: null, error: null }; // No remix lineage in these fixtures.
        let rows;
        if (insert) {
          const keys = Object.keys(insert);
          if (!keys.every((key) => /^[a-z_]+$/.test(key)))
            throw new Error('Invalid insert column');
          ({ rows } = await db.query(
            `insert into public.${table}(${keys.join(',')}) values(${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
            Object.values(insert),
          ));
        } else {
          if (!filters.length) throw new Error('Unbounded fixture read');
          ({ rows } = await db.query(
            `select * from public.${table} where ${filters.join(' and ')}${limit ? ` limit ${limit}` : ''}`,
            values,
          ));
        }
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      };
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          if (table !== 'completed_post_remixes' && !/^[a-z_]+$/.test(key))
            throw new Error('Invalid filter');
          values.push(value);
          filters.push(`${key}=$${values.length}`);
          return query;
        },
        in: (key: string, value: unknown[]) => {
          values.push(value);
          filters.push(`${key}=any($${values.length})`);
          return query;
        },
        is: (key: string) => {
          filters.push(`${key} is null`);
          return query;
        },
        not: (key: string) => {
          filters.push(`${key} is not null`);
          return query;
        },
        lt: (key: string, value: unknown) => {
          values.push(value);
          filters.push(`${key}<$${values.length}`);
          return query;
        },
        order: () => query,
        limit: (value: number) => {
          limit = value;
          return run(false);
        },
        insert: (value: Record<string, unknown>) => {
          insert = value;
          return query;
        },
        single: () => run(true),
        maybeSingle: () => run(true),
        then: (
          yes: (result: unknown) => unknown,
          no: (error: unknown) => unknown,
        ) => run(false).then(yes, no),
      };
      return query;
    },
    storage: {
      from: () => ({
        upload: async (path: string, stream: AsyncIterable<Uint8Array>) => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
            await barrier('during-upload');
          }
          const directory = process.env.AUDIT_CRASH_DIRECTORY!;
          await writeFile(
            join(directory, 'stored-output'),
            Buffer.concat(chunks),
          );
          await appendFile(
            join(directory, 'uploads.jsonl'),
            JSON.stringify({ path }) + '\n',
          );
          await barrier('after-upload');
          return { error: null };
        },
      }),
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (!rpcNames.has(name)) throw new Error(`Unexpected RPC ${name}`);
      if (name === 'finish_generation_output_import_job')
        await barrier('after-notification');
      const keys = Object.keys(args);
      if (!keys.every((key) => /^p_[a-z_]+$/.test(key)))
        throw new Error('Invalid RPC arguments');
      const setof =
        name === 'claim_generation_completion_jobs' ||
        name === 'claim_generation_output_import_jobs';
      const call = `public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')})`;
      const { rows } = await db.query(
        setof ? `select * from ${call}` : `select ${call} result`,
        Object.values(args).map((value) =>
          value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : value,
        ),
      );
      // Each call is autocommitted before its barrier is announced.
      if (setof && rows.length) await barrier('after-claim');
      if (name === 'start_generation') await barrier('after-reservation');
      if (name === 'settle_generation_succeeded')
        await barrier('after-settlement');
      if (name === 'enqueue_generation_output_import_job')
        await barrier('after-import-enqueue');
      return { data: setof ? rows : rows[0].result, error: null };
    },
  } as unknown as SupabaseClient;
}

it.skipIf(!workerMode)(
  'isolated generation worker',
  async () => {
    expect(['127.0.0.1', 'localhost']).toContain(
      new URL(connectionString!).hostname,
    );
    vi.stubGlobal('fetch', async (url: string) => {
      if (workerMode !== 'start' || !url.startsWith('https://api.kie.ai/'))
        throw new Error('External fetch forbidden in crash fixture');
      await appendFile(
        join(process.env.AUDIT_CRASH_DIRECTORY!, 'provider-calls'),
        'accepted\n',
      );
      await barrier('after-provider-accept');
      return Response.json({
        code: 200,
        data: { taskId: process.env.AUDIT_CRASH_TASK },
      });
    });
    const db = new Client({ connectionString, statement_timeout: 10_000 });
    await db.connect();
    try {
      const client = await databaseClient(db);
      const lockedBy = process.env.AUDIT_CRASH_OWNER!;
      let result: unknown;
      if (workerMode === 'start') {
        const { startImageGeneration } = await import(
          '@/lib/generation-services'
        );
        const { withGenerationStartIdempotency } = await import(
          '@/lib/generation-start-idempotency'
        );
        const userId = process.env.AUDIT_CRASH_USER!;
        result = await withGenerationStartIdempotency({
          client,
          userId,
          idempotencyKey: 'crash-start',
          requestHash: 'a'.repeat(64),
          owner: lockedBy,
          start: (key) =>
            startImageGeneration({
              supabase: client,
              creditSupabase: client,
              userId,
              clientRequestKeyHash: key,
              model: 'nano-banana-2',
              prompt: 'local process termination fixture',
              quotedCostCredits: 120,
              persistInputMedia: false,
            }),
        }).catch((error) => ({ code: error.code, message: error.message }));
      } else if (workerMode === 'callback') {
        const { handleKieWebhookForRoute } = await import(
          '@/lib/kie-webhook-service'
        );
        const taskId = process.env.AUDIT_CRASH_TASK!,
          generationId = process.env.AUDIT_CRASH_GENERATION!;
        const body = JSON.stringify({ data: { taskId, state: 'generating' } });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = createHmac('sha256', 'local-crash-hmac')
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
        result = await handleKieWebhookForRoute({
          createServiceClient: () => client,
          env: { KIE_WEBHOOK_HMAC_KEY: 'local-crash-hmac' },
          request: new Request(
            `http://localhost/api/webhooks/kie?generationId=${generationId}`,
            {
              method: 'POST',
              body,
              headers: {
                'content-type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-payload-signature': signature,
              },
            },
          ),
          scheduleAfter: () => {},
        });
      } else if (workerMode === 'reap') {
        result = await (
          await import('@/lib/stalled-generation-reaper')
        ).reapStalledGenerations({ supabase: client, creditSupabase: client });
      } else if (workerMode === 'completion') {
        result = await (
          await import('@/lib/generation-completion-jobs')
        ).processGenerationCompletionJobs({
          supabase: client,
          creditSupabase: client,
          lockedBy,
          limit: 1,
          predictionId: process.env.AUDIT_CRASH_TASK,
        });
      } else {
        result = await (
          await import('@/lib/generation-output-import-jobs-processor')
        ).processGenerationOutputImportJobs({ client, lockedBy, limit: 1 });
      }
      await writeFile(
        join(process.env.AUDIT_CRASH_DIRECTORY!, 'result.json'),
        JSON.stringify(result),
      );
    } finally {
      await db.end();
    }
  },
  60_000,
);

describe.skipIf(!connectionString || Boolean(workerMode))(
  'generation workers survive actual process termination',
  () => {
    let db: Client;
    let directory: string;
    let userId: string;
    let generationId: string;
    let taskId: string;
    const children = new Set<ChildProcess>();

    beforeEach(async () => {
      expect(['127.0.0.1', 'localhost']).toContain(
        new URL(connectionString!).hostname,
      );
      directory = await mkdtemp(join(tmpdir(), 'generation-crash-'));
      userId = randomUUID();
      generationId = randomUUID();
      taskId = `audit-crash-${randomUUID()}`;
      db = new Client({ connectionString, statement_timeout: 10_000 });
      await db.connect();
      // These fixtures are committed, so a separate process observes real leases.
      await db.query(
        "insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",
        [userId, `${userId}@example.invalid`],
      );
      await db.query(
        'update public.profiles set credits=500,promotional_credits=200 where id=$1',
        [userId],
      );
      await db.query(
        'insert into public.mobile_notification_preferences(user_id,push_enabled) values($1,false) on conflict(user_id) do update set push_enabled=false',
        [userId],
      );
      await db.query('set role service_role');
      const reserved = (
        await db.query(
          "select public.start_generation($1,120,'nano-banana-pro','local process termination fixture','image',null,null,null,'{}',null) result",
          [userId],
        )
      ).rows[0].result;
      expect(reserved.status).toBe('started');
      generationId = reserved.generation_id;
      await db.query('select public.attach_generation_provider_task($1,$2)', [
        generationId,
        taskId,
      ]);
    });
    afterEach(async () => {
      for (const child of children) {
        const closed = once(child, 'close');
        process.kill(-child.pid!, 'SIGKILL');
        await closed;
      }
      children.clear();
      try {
        await db?.query('reset role');
        await db?.query(
          'delete from public.generation_completion_jobs where prediction_id=$1',
          [taskId],
        );
        await db?.query('delete from public.generations where user_id=$1', [
          userId,
        ]);
        await db?.query(
          'delete from public.backend_job_locks where name like $1',
          [`generation-start:${userId}:%`],
        );
        await db?.query('delete from auth.users where id=$1', [userId]);
      } finally {
        await db?.end();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });

    function launch(mode: WorkerMode, point = '') {
      const child = spawn(
        process.execPath,
        [
          resolve('node_modules/vitest/vitest.mjs'),
          'run',
          fixtureFile,
          '-t',
          '^isolated generation worker$',
        ],
        {
          cwd: process.cwd(),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            AUDIT_CRASH_WORKER: mode,
            AUDIT_CRASH_POINT: point,
            AUDIT_CRASH_DIRECTORY: directory,
            AUDIT_CRASH_TASK: taskId,
            AUDIT_CRASH_USER: userId,
            AUDIT_CRASH_GENERATION: generationId,
            AUDIT_CRASH_OWNER: randomUUID(),
            TMPDIR: directory,
            KIE_WEBHOOK_HMAC_KEY: 'local-crash-hmac',
            KIE_PROVIDER_WEBHOOK_SECRET: 'local-crash-provider-secret',
            NEXT_PUBLIC_SUPABASE_URL: 'https://local-crash.invalid',
            KIE_AI_API_KEY: 'isolated-crash-test',
            GENERATION_MODEL_CATALOG_SOURCE: 'code',
          },
        },
      );
      children.add(child);
      let output = '';
      child.stdout!.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.stderr!.on('data', (chunk) => {
        output += chunk.toString();
      });
      const closed = once(child, 'close').then(([code, signal]) => {
        children.delete(child);
        return { code, signal };
      });
      return { child, closed, output: () => output };
    }
    async function killAt(mode: WorkerMode, point: string) {
      const worker = launch(mode, point);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (
          (await readFile(join(directory, 'barrier.json'), 'utf8').catch(
            () => '',
          )) !== ''
        )
          break;
        if (!children.has(worker.child))
          throw new Error(`Worker exited before ${point}: ${worker.output()}`);
        await delay(40);
      }
      const reached = JSON.parse(
        await readFile(join(directory, 'barrier.json'), 'utf8'),
      );
      expect(reached.point).toBe(point);
      // Kill the entire isolated Vitest process group, including its real worker.
      process.kill(-worker.child.pid!, 'SIGKILL');
      expect((await worker.closed).signal).toBe('SIGKILL');
    }
    async function recover(mode: WorkerMode) {
      const worker = launch(mode);
      const result = await worker.closed;
      expect(result.code, worker.output()).toBe(0);
      return JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    }
    async function state() {
      return (
        await db.query(
          `select g.status,g.refunded,g.output_url,p.credits,p.promotional_credits,
      (select count(*)::int from public.mobile_notifications where user_id=$2 and object_id=$1::uuid::text) notifications,
      (select count(*)::int from public.generation_output_import_jobs where generation_id=$1) imports
      from public.generations g join public.profiles p on p.id=g.user_id where g.id=$1`,
          [generationId, userId],
        )
      ).rows[0];
    }
    async function expire(table: string) {
      if (
        ![
          'generation_completion_jobs',
          'generation_output_import_jobs',
        ].includes(table)
      )
        throw new Error('Unexpected table');
      // Controlled fixture time advancement, not a claim that five wall-clock minutes elapsed.
      await db.query(
        `update public.${table} set locked_at=now()-interval '301 seconds' where prediction_id=$1`,
        [taskId],
      );
    }
    for (const point of ['after-reservation', 'after-provider-accept']) {
      it(`recovers a start after SIGKILL ${point}`, async () => {
        await db.query('delete from public.generations where id=$1', [
          generationId,
        ]);
        await db.query('reset role');
        await db.query(
          'update public.profiles set credits=500,promotional_credits=200 where id=$1',
          [userId],
        );
        await db.query('set role service_role');
        await killAt('start', point);
        generationId = (
          await db.query('select id from public.generations where user_id=$1', [
            userId,
          ])
        ).rows[0].id;
        expect(await state()).toMatchObject({
          status: 'pending',
          refunded: false,
          credits: 380,
          promotional_credits: 80,
        });
        expect(await recover('start')).toMatchObject({
          code: 'GENERATION_START_IN_PROGRESS',
        });
        if (point === 'after-provider-accept') {
          expect(await recover('callback')).toMatchObject({ status: 200 });
          expect(await recover('start')).toMatchObject({
            idempotentReplay: true,
            generationId,
            predictionId: taskId,
          });
          expect(await state()).toMatchObject({
            status: 'processing',
            refunded: false,
            credits: 380,
            promotional_credits: 80,
          });
        } else {
          await db.query(
            "update public.generations set created_at=now()-interval '46 minutes' where id=$1",
            [generationId],
          );
          expect(await recover('reap')).toMatchObject({
            startFailures: { settled: 1 },
          });
          expect(await state()).toMatchObject({
            status: 'failed',
            refunded: true,
            credits: 500,
            promotional_credits: 200,
          });
          expect(await recover('reap')).toMatchObject({
            startFailures: { settled: 0 },
          });
        }
        const calls = await readFile(
          join(directory, 'provider-calls'),
          'utf8',
        ).catch(() => '');
        expect(calls).toBe(
          point === 'after-provider-accept' ? 'accepted\n' : '',
        );
      }, 60_000);
    }
    for (const point of ['after-claim', 'after-import-enqueue']) {
      it(`recovers completion after SIGKILL ${point}`, async () => {
        await db.query(
          'select public.enqueue_generation_completion_job($1,$2)',
          [
            taskId,
            JSON.stringify({
              data: {
                taskId,
                state: 'success',
                resultJson: JSON.stringify({
                  resultUrls: ['https://provider.invalid/output.png'],
                }),
              },
            }),
          ],
        );
        await killAt('completion', point);
        expect(await recover('completion')).toMatchObject({ claimed: 0 });
        await expire('generation_completion_jobs');
        expect(await recover('completion')).toMatchObject({
          claimed: 1,
          completed: 1,
        });
        expect(await state()).toMatchObject({
          status: 'processing',
          refunded: false,
          credits: 380,
          promotional_credits: 80,
          imports: 1,
        });
        expect(
          (
            await db.query(
              'select status from public.generation_completion_jobs where prediction_id=$1',
              [taskId],
            )
          ).rows[0].status,
        ).toBe('succeeded');
      }, 45_000);
    }
    for (const point of [
      'after-claim',
      'during-upload',
      'after-upload',
      'after-settlement',
      'after-notification',
    ]) {
      it(`recovers output import after SIGKILL ${point}`, async () => {
        await db.query(
          'select public.enqueue_generation_output_import_job($1,$2)',
          [
            generationId,
            JSON.stringify(['https://provider.invalid/output.png']),
          ],
        );
        await killAt('import', point);
        const before = await state();
        expect(before.status).toBe(
          ['after-settlement', 'after-notification'].includes(point)
            ? 'succeeded'
            : 'processing',
        );
        expect(before.notifications).toBe(
          point === 'after-notification' ? 1 : 0,
        );
        expect(await recover('import')).toMatchObject({ claimed: 0 });
        await expire('generation_output_import_jobs');
        expect(await recover('import')).toMatchObject({
          claimed: 1,
          completed: 1,
          exhausted: 0,
        });
        expect(await state()).toMatchObject({
          status: 'succeeded',
          refunded: false,
          credits: 380,
          promotional_credits: 80,
          notifications: 1,
          imports: 1,
        });
        const uploads = (
          await readFile(join(directory, 'uploads.jsonl'), 'utf8')
        )
          .trim()
          .split('\n');
        expect(uploads).toHaveLength(point === 'after-upload' ? 2 : 1);
        expect(new Set(uploads.map((line) => JSON.parse(line).path)).size).toBe(
          1,
        );
        expect(await readFile(join(directory, 'stored-output'), 'utf8')).toBe(
          'isolated worker media bytes',
        );
        expect(await recover('import')).toMatchObject({ claimed: 0 });
        expect(
          (
            await db.query(
              'select status from public.generation_output_import_jobs where generation_id=$1',
              [generationId],
            )
          ).rows[0].status,
        ).toBe('succeeded');
        // Crashed staging files are deliberately confined to this fixture TMPDIR.
        // Record their presence; recovery does not promise SIGKILL finally cleanup.
        expect(
          (await readdir(directory)).filter((name) =>
            name.startsWith('remote-media-'),
          ).length,
        ).toBe(
          ['during-upload', 'after-upload', 'after-settlement'].includes(point)
            ? 1
            : 0,
        );
      }, 60_000);
    }
  },
);
