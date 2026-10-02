import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { startImageGeneration, type TemplateGenerationContext } from '@/lib/generation-services';
import { findStrandedTemplateRuns } from '@/lib/template-run-jobs';
import { processTemplateRunJobs } from '@/lib/template-run-jobs-processor';
import {
  abandonTemplateRun,
  getTemplateRun,
  TEMPLATE_RUN_ABANDONED_MESSAGE,
} from '@/lib/template-run-service';

import {
  createTemplateRunPostgresClient,
  removeStarterTemplateRun,
  seedStarterTemplateRun,
  type StarterTemplateRun,
} from './fixtures/template-run-postgres';

// The provider key and the callback settings are read when the generation
// modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'local-template-run-test');
  vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'local-template-run-provider-secret');
  vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'local-template-run-hmac');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://local-template-run.invalid');
  vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'code');
});

const service = vi.hoisted(() => ({ client: null as unknown }));

// The provider, the gate in front of it and the poll of a running generation
// are outside boundaries. The job processor, the run worker, the start service
// and the job queue run their real code against real SQL.
vi.mock('@/lib/provider-admission', async (original) => ({
  ...(await original<typeof import('@/lib/provider-admission')>()),
  admitProviderSubmission: vi.fn(),
  recordProviderSubmissionOutcome: vi.fn(),
}));
vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: async () => undefined,
}));
vi.mock('@/lib/server-helpers', async (original) => ({
  ...(await original<typeof import('@/lib/server-helpers')>()),
  createServiceClient: () => service.client,
  resolveOwnedStoredMediaUrl: async (_client: unknown, value: string) => `signed:${value}`,
}));

type StepStart = {
  supabase: SupabaseClient;
  userId: string;
  clientRequestKeyHash?: string | null;
  persistInputMedia?: boolean;
  privateRecipe?: boolean;
  templateContext?: TemplateGenerationContext;
};

// The node executor is stood in for by the one thing it does for an image
// step: the real start service, called with the context the worker gave it.
vi.mock('@/lib/workflow-runner', () => ({
  executeWorkflowRunnableNode: async (params: StepStart) => {
    const started = await startImageGeneration({
      supabase: params.supabase,
      creditSupabase: params.supabase,
      userId: params.userId,
      prompt: 'A ceramic mug on a linen cloth',
      model: 'nano-banana-2',
      clientRequestKeyHash: params.clientRequestKeyHash,
      persistInputMedia: params.persistInputMedia,
      privateRecipe: params.privateRecipe,
      templateContext: params.templateContext,
    });
    return {
      status: 'processing',
      generation_id: started.generationId ?? null,
      input_snapshot: {},
      output_snapshot: { predictionId: started.predictionId, cost: started.cost },
      error_message: null,
    };
  },
}));


const connectionString = process.env.SUPABASE_TEST_DB_URL;
const STARTING_CREDITS = 500;
const MINUTE = 60_000;
/** What PostgREST answers when a read is cancelled: an error object, and no rows. */
const STATEMENT_TIMEOUT = {
  code: '57014',
  details: null,
  hint: null,
  message: 'canceling statement due to statement timeout',
};
const NOT_FINISHED = 'This step was not finished because the run stopped.';
const STOPPED_MID_GENERATION = 'This step was still generating when the run stopped, so its credits stay spent.';
/** Failures the worker logs and carries on from. A test that meets one has not shown what it claims. */
const SWALLOWED_FAILURES = [
  'template_run_sweep_failed',
  'template_run_adopt_failed',
  'template_run_abandon_cleanup_failed',
  'template_run_job_finish_failed',
  'failed_to_create_mobile_notification',
  'failed_to_clean_up_template_inputs',
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A query on a table that cannot be read: every way of awaiting it gets the error. */
function cancelledQuery() {
  const answer = Promise.resolve({ data: null, error: STATEMENT_TIMEOUT });
  const query: Record<string, unknown> = {
    maybeSingle: () => answer,
    single: () => answer,
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => answer.then(resolve, reject),
  };
  for (const method of ['select', 'insert', 'update', 'eq', 'neq', 'in', 'order']) query[method] = () => query;
  return query;
}

describe.skipIf(!connectionString)('a template run whose job runs out of attempts, with real PostgreSQL', () => {
  let admin: Client;
  let worker: Client;
  let client: SupabaseClient;
  let seed: StarterTemplateRun;
  let userId: string;
  let runId: string;
  /** While it lasts, the run's steps cannot be read, so every pass of the worker fails at its first step. */
  const outage = { active: false };
  /** The uploads storage was asked to delete. */
  const removedInputs: string[] = [];
  let logs: BackendLogRecord[] = [];
  let restoreLogSink = () => {};

  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = new Client({ connectionString, statement_timeout: 10_000 });
    worker = new Client({ connectionString, statement_timeout: 10_000 });
    await admin.connect();
    await worker.connect();
    // The worker runs as the service role, under the grants it has in production.
    await worker.query('set role service_role');
  });
  afterAll(async () => {
    await worker?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn());
    // The provider client reports every refused call on the console, and the
    // processor logs each pass that fails. Neither is what these tests assert on.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    outage.active = false;
    removedInputs.length = 0;
    logs = [];
    restoreLogSink = setBackendLogSink((record) => logs.push(record));

    // The sweep looks at every run in progress, and the processor claims
    // whichever ticket is due. Another file's run would be worked on here.
    const others = await admin.query(
      `select (select count(*)::int from public.template_runs where status in ('queued','processing')) as runs,
              (select count(*)::int from public.template_run_jobs where status in ('pending','processing')) as tickets`,
    );
    expect(others.rows[0]).toEqual({ runs: 0, tickets: 0 });

    seed = await seedStarterTemplateRun(admin, { credits: STARTING_CREDITS, title: 'Job exhaustion fixture' });
    ({ userId, runId } = seed);

    const database = createTemplateRunPostgresClient(worker);
    client = {
      ...database,
      from: (table: string) => (
        outage.active && table === 'template_run_steps' ? cancelledQuery() : database.from(table)
      ),
      storage: {
        from: (bucket: string) => ({
          ...database.storage.from(bucket),
          remove: async (paths: string[]) => {
            removedInputs.push(...paths);
            return { error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;
    service.client = client;

    // The start route: the run is queued, and its ticket is written.
    await admin.query('select public.enqueue_template_run_job($1)', [runId]);
  });

  afterEach(async () => {
    restoreLogSink();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    service.client = null;
    await removeStarterTemplateRun(admin, seed);
    expect(logs.filter((record) => SWALLOWED_FAILURES.includes(record.msg))).toEqual([]);
  });

  function providerIsBusy() {
    vi.mocked(fetch).mockImplementation(async () => json({ msg: 'Too many requests' }, 429));
  }
  function providerHasRoom() {
    vi.mocked(fetch).mockImplementation(async () => json({ code: 200, data: { taskId: `task-${randomUUID()}` } }));
  }

  /**
   * One call of the worker, as the cron job, a provider callback and the run's
   * routes make it. `minutesLater` moves the sweep's clock: the database keeps
   * its own, so what the sweep reads looks that much older to it.
   */
  const process = (minutesLater = 0) => processTemplateRunJobs({
    client,
    lockedBy: `exhaustion-${runId}`,
    nowMs: Date.now() + minutesLater * MINUTE,
  });
  /** The ticket's retry delay has passed. */
  const delayPassed = () => admin.query('update public.template_run_jobs set next_attempt_at=now() where run_id=$1', [runId]);
  async function job() {
    return (await admin.query(
      'select status, attempt_count, last_error from public.template_run_jobs where run_id=$1',
      [runId],
    )).rows[0] as { status: string; attempt_count: number; last_error: string | null };
  }
  async function run() {
    return (await admin.query(
      `select status, error_message, completed_at is not null as completed,
              input_storage_paths, inputs_deleted_at is not null as inputs_deleted
       from public.template_runs where id=$1`,
      [runId],
    )).rows[0] as {
      status: string;
      error_message: string | null;
      completed: boolean;
      input_storage_paths: Record<string, string>;
      inputs_deleted: boolean;
    };
  }
  /** Each step as the run page lists it: generations before reviews, images before the video. */
  async function steps() {
    return (await admin.query(
      `select kind, media_kind, status, error_message, output_url is not null as has_output
       from public.template_run_steps where run_id=$1 order by kind desc, media_kind, status`,
      [runId],
    )).rows as Array<{ kind: string; media_kind: string; status: string; error_message: string | null; has_output: boolean }>;
  }
  async function notifications() {
    return (await admin.query(
      `select type, category, title, body, deep_link, object_type, object_id
       from public.mobile_notifications where user_id=$1 order by created_at`,
      [userId],
    )).rows;
  }
  const logged = (event: string) => logs.filter((record) => record.msg === event);
  async function credits() {
    return (await admin.query('select credits from public.profiles where id=$1', [userId])).rows[0].credits as number;
  }
  /** Whether the run is in progress with no ticket a worker could ever claim. */
  async function stranded() {
    const { rows } = await admin.query(
      `select 1 from public.template_runs as runs
       left join public.template_run_jobs as jobs on jobs.run_id = runs.id
       where runs.id=$1 and runs.status in ('queued','processing')
         and coalesce(jobs.status, 'none') not in ('pending','processing')`,
      [runId],
    );
    return rows.length > 0;
  }
  /** Passes of the worker, each as soon as the last one's retry delay is over: [claimed, retried, exhausted] of each. */
  async function passes(count: number) {
    const outcomes = [];
    for (let pass = 1; pass <= count; pass += 1) {
      const outcome = await process();
      outcomes.push([outcome.claimed, outcome.retried, outcome.exhausted]);
      await delayPassed();
    }
    return outcomes;
  }
  /** Five passes of the worker during the outage, which spend the ticket. */
  async function failFivePasses() {
    outage.active = true;
    const outcomes = await passes(5);
    outage.active = false;
    return outcomes;
  }
  const stoppedNotification = () => ({
    type: 'generation_failed',
    category: 'generation',
    title: 'Your template run stopped',
    body: 'A problem on our side ended it. Open it to start again.',
    deep_link: `/template-runs/${runId}`,
    object_type: 'template_run',
    object_id: runId,
  });

  it('five failed passes spend the ticket, and the run is picked up again once passes work', async () => {
    expect(await failFivePasses()).toEqual([
      [1, 1, 0],
      [1, 1, 0],
      [1, 1, 0],
      [1, 1, 0],
      [1, 0, 1],
    ]);
    // The ticket says why: the database's own words, not "[object Object]".
    expect(await job()).toEqual({ status: 'failed', attempt_count: 5, last_error: STATEMENT_TIMEOUT.message });
    // No step was started, so nothing is in flight that could wake the run.
    expect(await run()).toMatchObject({ status: 'queued', error_message: null });
    expect((await admin.query('select public.has_due_template_run_jobs(300) as due')).rows[0].due).toBe(false);

    // The run page keeps asking, and a read wakes nothing.
    const shown = await getTemplateRun({ adminClient: client, runId, userId });
    expect(shown.status).toBe('queued');
    expect((await job()).status).toBe('failed');

    // What the cron job asks before it runs at all. A pass may be letting its
    // ticket go this very moment, so a ticket has to be dead for two minutes.
    expect(await findStrandedTemplateRuns(client, { nowMs: Date.now() + MINUTE })).toEqual([]);
    expect(await findStrandedTemplateRuns(client, { nowMs: Date.now() + 3 * MINUTE })).toEqual([
      { id: runId, user_id: userId, updated_at: expect.any(String), last_error: STATEMENT_TIMEOUT.message },
    ]);

    providerHasRoom();
    expect(await process(1)).toMatchObject({ adopted: 0, abandoned: 0, claimed: 0 });
    expect(await process(3)).toMatchObject({ adopted: 1, abandoned: 0, claimed: 1, deferred: 1 });

    // The run carries on from where it was: its two images are generating.
    expect(await run()).toMatchObject({ status: 'processing', error_message: null });
    expect(await job()).toEqual({ status: 'pending', attempt_count: 0, last_error: null });
    expect(await stranded()).toBe(false);
    expect(await notifications()).toEqual([]);
  });

  it('failed passes are counted over the whole run, and the run carries on all the same', async () => {
    providerIsBusy();
    for (let failure = 1; failure <= 4; failure += 1) {
      outage.active = true;
      expect(await process()).toMatchObject({ claimed: 1, retried: 1 });
      await delayPassed();
      // The provider is busy, so the steps wait in line and the ticket is deferred.
      outage.active = false;
      expect(await process()).toMatchObject({ claimed: 1, deferred: 1 });
      await delayPassed();
    }
    // A pass that works does not clear the count.
    expect(await job()).toMatchObject({ status: 'pending', attempt_count: 4 });

    // The fifth failure, with a working pass since each of the other four.
    outage.active = true;
    expect(await process()).toMatchObject({ claimed: 1, exhausted: 1 });
    outage.active = false;
    expect(await run()).toMatchObject({ status: 'queued' });
    expect(await stranded()).toBe(true);

    expect(await process(3)).toMatchObject({ adopted: 1, abandoned: 0, claimed: 1, deferred: 1 });

    expect(await run()).toMatchObject({ status: 'queued', error_message: null });
    expect(await stranded()).toBe(false);
    expect(await notifications()).toEqual([]);
  });

  it('a run whose result can never be verified is ended, and the person is told', async () => {
    // Every step of the run has succeeded and is paid for.
    const finished = (await admin.query(
      'select id, kind, media_kind from public.template_run_steps where run_id=$1 order by kind desc, media_kind',
      [runId],
    )).rows as Array<{ id: string; kind: string; media_kind: string }>;
    for (const step of finished) {
      const outputUrl = `generations/${userId}/${step.id}.${step.media_kind === 'video' ? 'mp4' : 'png'}`;
      let generationId: string | null = null;
      if (step.kind === 'generation') {
        generationId = randomUUID();
        await admin.query(
          `insert into public.generations(id,user_id,model,status,category,prompt,template_run_id,template_run_step_id,output_url,cost,actual_cost)
           values($1,$2,'job-exhaustion-fixture','succeeded',$3,'fixture',$4,$5,$6,10,10)`,
          [generationId, userId, step.media_kind, runId, step.id, outputUrl],
        );
      }
      await admin.query(
        "update public.template_run_steps set status='succeeded', generation_id=$2, output_url=$3, finished_at=now() where id=$1",
        [step.id, generationId, outputUrl],
      );
    }
    // The result's file has since moved, so the step and its generation no
    // longer name the same output. The worker refuses to publish a result it
    // cannot tie to its generation, on every pass.
    await admin.query(
      "update public.generations set output_url = output_url || '.moved' where template_run_id=$1 and category='video'",
      [runId],
    );
    await admin.query("update public.template_runs set status='processing' where id=$1", [runId]);

    expect((await passes(5))[4]).toEqual([1, 0, 1]);
    expect(await job()).toEqual({
      status: 'failed',
      attempt_count: 5,
      last_error: 'The final template result could not be verified.',
    });

    // Three minutes later the run is picked up again, and nothing has changed for it.
    expect(await process(3)).toMatchObject({ adopted: 1, abandoned: 0, claimed: 1, retried: 1 });
    await delayPassed();
    expect((await passes(4))[3]).toEqual([1, 0, 1]);
    expect(await run()).toMatchObject({ status: 'processing', error_message: null });

    // Forty minutes without one pass that worked.
    expect(await process(40)).toMatchObject({ adopted: 0, abandoned: 1, claimed: 0 });

    expect(await run()).toEqual({
      status: 'failed',
      error_message: TEMPLATE_RUN_ABANDONED_MESSAGE,
      completed: true,
      input_storage_paths: {},
      inputs_deleted: true,
    });
    expect(await notifications()).toEqual([stoppedNotification()]);
    // The operator's line carries why the passes failed.
    expect(logged('template_run_abandoned')).toEqual([expect.objectContaining({
      level: 'error', runId, userId, lastError: 'The final template result could not be verified.',
    })]);
    // What both clients draw: the failed state, with the message.
    const shown = await getTemplateRun({ adminClient: client, runId, userId });
    expect([shown.status, shown.errorMessage]).toEqual(['failed', TEMPLATE_RUN_ABANDONED_MESSAGE]);
    // The steps keep what they made.
    expect((await steps()).map((step) => [step.kind, step.status, step.has_output])).toEqual([
      ['generation', 'succeeded', true],
      ['generation', 'succeeded', true],
      ['generation', 'succeeded', true],
      ['approval', 'succeeded', true],
      ['approval', 'succeeded', true],
    ]);
    expect(await stranded()).toBe(false);

    // It is over: later runs of the cron job leave it alone and say nothing more.
    expect(await findStrandedTemplateRuns(client, { nowMs: Date.now() + 60 * MINUTE })).toEqual([]);
    expect(await process(60)).toMatchObject({ adopted: 0, abandoned: 0, claimed: 0 });
    expect(await notifications()).toHaveLength(1);
    expect(logged('template_run_abandoned')).toHaveLength(1);
  });

  it('a run given up on before any step started has its steps cancelled and its uploads removed', async () => {
    const inputs = Object.values((await run()).input_storage_paths);
    expect(inputs.length).toBeGreaterThan(0);
    await failFivePasses();

    // Nothing has written the run since it was queued a moment ago, so a
    // caller whose give-up time began before that is turned away.
    expect(await abandonTemplateRun({
      client, runId, userId, idleBefore: new Date(Date.now() - MINUTE).toISOString(),
    })).toBe(false);
    expect(await run()).toMatchObject({ status: 'queued', error_message: null });

    expect(await process(40)).toMatchObject({ adopted: 0, abandoned: 1, claimed: 0 });

    expect(await run()).toEqual({
      status: 'failed',
      error_message: TEMPLATE_RUN_ABANDONED_MESSAGE,
      completed: true,
      input_storage_paths: {},
      inputs_deleted: true,
    });
    expect((await steps()).map((step) => [step.kind, step.media_kind, step.status, step.error_message])).toEqual([
      ['generation', 'image', 'cancelled', NOT_FINISHED],
      ['generation', 'image', 'cancelled', NOT_FINISHED],
      ['generation', 'video', 'cancelled', NOT_FINISHED],
      ['approval', 'image', 'cancelled', NOT_FINISHED],
      ['approval', 'image', 'cancelled', NOT_FINISHED],
    ]);
    expect(removedInputs.sort()).toEqual(inputs.map((value) => value.replace(/^template_inputs\//, '')).sort());
    expect(await credits()).toBe(STARTING_CREDITS);
    expect(await notifications()).toEqual([stoppedNotification()]);
  });

  it('the steps of a run given up on show what became of their generations', async () => {
    providerHasRoom();
    expect(await process()).toMatchObject({ claimed: 1, deferred: 1 });
    await delayPassed();
    // The provider finishes one of the two images, and the other never comes back.
    const finished = await admin.query(
      `update public.generations set status='succeeded', output_url='generations/' || user_id || '/' || id || '.png', completed_at=now()
       where id = (select id from public.generations where template_run_id=$1 and status='processing' order by created_at, id limit 1)`,
      [runId],
    );
    expect(finished.rowCount).toBe(1);
    await delayPassed();
    await failFivePasses();
    expect(await job()).toMatchObject({ status: 'failed', attempt_count: 5 });
    const held = await credits();

    expect(await process(40)).toMatchObject({ adopted: 0, abandoned: 1, claimed: 0 });

    expect(await run()).toMatchObject({ status: 'failed', error_message: TEMPLATE_RUN_ABANDONED_MESSAGE });
    expect((await steps()).map((step) => [step.kind, step.media_kind, step.status, step.error_message, step.has_output])).toEqual([
      // Still with the provider, which cannot be told to stop.
      ['generation', 'image', 'cancelled', STOPPED_MID_GENERATION, false],
      // Finished while no pass could record it.
      ['generation', 'image', 'succeeded', null, true],
      ['generation', 'video', 'cancelled', NOT_FINISHED, false],
      ['approval', 'image', 'cancelled', NOT_FINISHED, false],
      ['approval', 'image', 'cancelled', NOT_FINISHED, false],
    ]);
    // Ending the run moves no credits: what was spent or held stays as it was.
    expect(await credits()).toBe(held);
    expect(await notifications()).toEqual([stoppedNotification()]);
  });

  it('a generation of the run that finishes later writes the ticket again', async () => {
    providerHasRoom();
    expect(await process()).toMatchObject({ claimed: 1, deferred: 1 });
    expect(await run()).toMatchObject({ status: 'processing' });
    await delayPassed();

    expect((await failFivePasses())[4]).toEqual([1, 0, 1]);
    expect(await job()).toMatchObject({ status: 'failed', attempt_count: 5 });

    // The provider's callback for one of the two images.
    const finished = await admin.query(
      `update public.generations set status='succeeded', output_url='generations/' || user_id || '/' || id || '.png', completed_at=now()
       where id = (select id from public.generations where template_run_id=$1 and status='processing' order by created_at, id limit 1)`,
      [runId],
    );
    expect(finished.rowCount).toBe(1);

    expect(await job()).toEqual({ status: 'pending', attempt_count: 0, last_error: null });
    expect(await process()).toMatchObject({ adopted: 0, claimed: 1 });
  });
});
