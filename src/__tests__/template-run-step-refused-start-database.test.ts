import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { startImageGeneration, type TemplateGenerationContext } from '@/lib/generation-services';
import { processTemplateRunJobs } from '@/lib/template-run-jobs-processor';
import { getTemplateRun, retryTemplateRunStep } from '@/lib/template-run-service';

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
// are outside boundaries. The job processor, the run worker, the start
// service, the notifier and the job queue run their real code against real SQL.
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
/** What the person reads on a step the database refused, when a retry can start. */
const REFUSED = 'This step could not be started because of a problem on our side. No credits were used for it. Retry it to continue.';
/** And when a retry would be refused as well. */
const REFUSED_FOR_GOOD = 'This step could not be started because of a problem on our side, and retrying it will not help. No credits were used for it. Start a new run to try again.';
/** What a step whose generation the provider refused reads. */
const PROVIDER_REFUSED = 'The generation provider could not accept this request. Check the template inputs before retrying.';
/** Failures the worker logs and carries on from. A test that meets one has not shown what it claims. */
const SWALLOWED_FAILURES = [
  'template_run_sweep_failed',
  'template_run_adopt_failed',
  'template_run_abandon_cleanup_failed',
  'template_run_job_finish_failed',
  'failed_to_create_mobile_notification',
  'failed_to_notify_run_step_start_failure',
  'failed_to_clean_up_template_inputs',
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe.skipIf(!connectionString)('a template run step the database will not start, with real PostgreSQL', () => {
  let admin: Client;
  let worker: Client;
  /** A second pass of the worker, or the person, on a connection of its own. */
  let other: Client;
  let workerPid: number;
  let client: SupabaseClient;
  let seed: StarterTemplateRun;
  let userId: string;
  let runId: string;
  /** The two image steps the run starts with, in the order the worker starts them. */
  let imageSteps: Array<{ id: string; node_id: string }> = [];
  /** What `start_template_generation` answered, in order. */
  let startAnswers: string[] = [];
  let logs: BackendLogRecord[] = [];
  let restoreLogSink = () => {};

  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = new Client({ connectionString, statement_timeout: 10_000 });
    worker = new Client({ connectionString, statement_timeout: 10_000 });
    other = new Client({ connectionString, statement_timeout: 10_000 });
    await Promise.all([admin.connect(), worker.connect(), other.connect()]);
    // The worker runs as the service role, under the grants it has in production.
    await worker.query('set role service_role');
    await other.query('set role service_role');
    workerPid = (await worker.query('select pg_backend_pid() as pid')).rows[0].pid as number;
  });
  afterAll(async () => {
    await Promise.all([worker?.end(), other?.end(), admin?.end()]);
  });

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn());
    // The provider client reports every refused call on the console.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logs = [];
    restoreLogSink = setBackendLogSink((record) => logs.push(record));

    // The sweep looks at every run in progress, and the processor claims
    // whichever ticket is due. Another file's run would be worked on here.
    const others = await admin.query(
      `select (select count(*)::int from public.template_runs where status in ('queued','processing')) as runs,
              (select count(*)::int from public.template_run_jobs where status in ('pending','processing')) as tickets`,
    );
    expect(others.rows[0]).toEqual({ runs: 0, tickets: 0 });

    seed = await seedStarterTemplateRun(admin, { credits: STARTING_CREDITS, title: 'Refused start fixture' });
    ({ userId, runId } = seed);
    startAnswers = [];
    client = createTemplateRunPostgresClient(worker, startAnswers);
    service.client = client;
    imageSteps = (await admin.query(
      "select id, node_id from public.template_run_steps where run_id=$1 and kind='generation' and media_kind='image'",
      [runId],
    )).rows as Array<{ id: string; node_id: string }>;
    expect(imageSteps).toHaveLength(2);

    // The start route: the run is queued, and its ticket is written.
    await admin.query('select public.enqueue_template_run_job($1)', [runId]);
  });

  afterEach(async () => {
    restoreLogSink();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    service.client = null;
    // A case that failed half way must not leave its transaction open.
    await other.query('rollback');
    await removeStarterTemplateRun(admin, seed);
    expect(logs.filter((record) => SWALLOWED_FAILURES.includes(record.msg))).toEqual([]);
  });

  /** The provider answers and turns the request down for good: nothing will run. */
  function providerRefuses() {
    vi.mocked(fetch).mockImplementation(async () => json({ code: 422, msg: 'The request was not accepted.' }));
  }
  function providerHasRoom() {
    vi.mocked(fetch).mockImplementation(async () => json({ code: 200, data: { taskId: `task-${randomUUID()}` } }));
  }

  /** One call of the worker, as the cron job, a provider callback and the run's routes make it. */
  const process = () => processTemplateRunJobs({ client, lockedBy: `refused-start-${runId}` });
  /** The ticket's delay has passed. */
  const delayPassed = () => admin.query('update public.template_run_jobs set next_attempt_at=now() where run_id=$1', [runId]);
  async function ticket() {
    return (await admin.query('select status from public.template_run_jobs where run_id=$1', [runId])).rows[0].status as string;
  }
  async function run() {
    return (await admin.query('select status, error_message from public.template_runs where id=$1', [runId])).rows[0] as {
      status: string;
      error_message: string | null;
    };
  }
  /** Every attempt of the two image steps: [attempt, status, its generation's status]. */
  async function imageAttempts() {
    const { rows } = await admin.query(
      `select steps.node_id, steps.attempt, steps.status, generations.status as generation_status
       from public.template_run_steps as steps
       left join public.generations on generations.id = steps.generation_id
       where steps.run_id=$1 and steps.node_id = any($2)
       order by steps.attempt`,
      [runId, imageSteps.map((step) => step.node_id)],
    );
    return imageSteps.map((step) => rows.filter((row) => row.node_id === step.node_id)
      .map((row) => [row.attempt, row.status, row.generation_status]));
  }
  /** The first attempt of each image step, as its row stands. */
  async function imageRows() {
    const { rows } = await admin.query(
      `select id, status, error_message, can_retry, finished_at is not null as finished, generation_id
       from public.template_run_steps where id = any($1)`,
      [imageSteps.map((step) => step.id)],
    );
    return imageSteps.map((step) => rows.find((row) => row.id === step.id)) as Array<{
      id: string;
      status: string;
      error_message: string | null;
      can_retry: boolean;
      finished: boolean;
      generation_id: string | null;
    }>;
  }
  /** What the run page and the app are sent for the two image steps and for the steps after them. */
  async function shown() {
    const dto = await getTemplateRun({ adminClient: client, runId, userId });
    const nodeOf = new Map((await admin.query(
      'select id, node_id from public.template_run_steps where run_id=$1',
      [runId],
    )).rows.map((row) => [row.id as string, row.node_id as string]));
    const imageNodes = imageSteps.map((step) => step.node_id);
    return {
      run: [dto.status, dto.errorMessage],
      // The attempt the run is on for each image step.
      images: imageNodes.map((nodeId) => dto.steps.find((step) => nodeOf.get(step.id) === nodeId)!)
        .map((step) => [step.status, step.errorMessage, step.failureCode, step.canRetry]),
      later: dto.steps.filter((step) => !imageNodes.includes(nodeOf.get(step.id) ?? ''))
        .map((step) => [step.kind, step.status, step.errorMessage]),
    };
  }
  async function notifications() {
    return (await admin.query(
      `select type, category, title, body, deep_link, object_type, object_id, dedupe_key
       from public.mobile_notifications where user_id=$1 order by dedupe_key`,
      [userId],
    )).rows as Array<Record<string, string | null>>;
  }
  async function generations() {
    return (await admin.query(
      'select id, status, cost, refunded, prediction_id is not null as with_provider from public.generations where template_run_id=$1 order by created_at, id',
      [runId],
    )).rows as Array<{ id: string; status: string; cost: number; refunded: boolean; with_provider: boolean }>;
  }
  async function credits() {
    return (await admin.query('select credits from public.profiles where id=$1', [userId])).rows[0].credits as number;
  }
  const logged = (event: string) => logs.filter((record) => record.msg === event);
  /** The request key the worker sends for the first attempt of a step. */
  const requestKey = (nodeId: string) => createHash('sha256').update(`template-run:${runId}:${nodeId}:0`).digest('hex');

  /** Puts the two image step rows back in line and the run with them, as an edit by hand does. */
  async function putBackInLine() {
    await admin.query(
      "update public.template_run_steps set status='queued', error_message=null, finished_at=null, output_snapshot=null where id = any($1)",
      [imageSteps.map((step) => step.id)],
    );
    // The status change writes the run's ticket again.
    await admin.query("update public.template_runs set status='queued', error_message=null where id=$1", [runId]);
    await delayPassed();
  }

  /**
   * Both image steps were started once, the provider refused them, and their
   * credits were returned. Then the rows were put back in line: what the
   * worker did with a busy refusal before it retried a busy step as a new
   * attempt, and what an edit by hand can still do. The refund cleared each
   * generation's request key, so the database answers
   * `template_step_already_started`.
   */
  async function startedOnceAndPutBackInLine() {
    providerRefuses();
    expect(await process()).toMatchObject({ claimed: 1, completed: 1 });
    expect(await imageAttempts()).toEqual([[[0, 'failed', 'failed']], [[0, 'failed', 'failed']]]);
    await putBackInLine();
  }

  /**
   * As above, but each failed generation still holds its request key, so the
   * database answers `key_already_used`. No code path writes this today: the
   * settlement of a refused start clears the key.
   */
  async function failedStartKeptItsKey() {
    await startedOnceAndPutBackInLine();
    for (const row of await imageRows()) {
      const nodeId = imageSteps.find((step) => step.id === row.id)!.node_id;
      await admin.query('update public.generations set client_request_key_hash=$2 where id=$1', [row.generation_id, requestKey(nodeId)]);
    }
  }

  /** The provider finishes every image the run has with it. */
  async function providerFinishesTheImages() {
    await admin.query(
      `update public.generations set status='succeeded', output_url='generations/' || user_id || '/' || id || '.png', completed_at=now()
       where template_run_id=$1 and status='processing'`,
      [runId],
    );
    await delayPassed();
  }

  describe('a step that is in line but was already started', () => {
    it.each([
      ['its refund cleared the request key', () => startedOnceAndPutBackInLine()],
      ['its failed start still holds the request key', () => failedStartKeptItsKey()],
    ])('takes the failure of the generation it was started with when %s', async (_shape, arrange) => {
      await arrange();
      const announced = await notifications();
      logs = [];
      startAnswers.length = 0;

      // The first pass ends the wait, and never asks the database to start the rows.
      expect(await process()).toMatchObject({ claimed: 1, completed: 1, deferred: 0, retried: 0 });
      expect(startAnswers).toEqual([]);
      expect(await ticket()).toBe('succeeded');
      expect(await run()).toEqual({ status: 'needs_attention', error_message: PROVIDER_REFUSED });
      expect((await imageRows()).map((row) => [row.status, row.error_message, row.can_retry, row.finished])).toEqual([
        ['failed', PROVIDER_REFUSED, true, true],
        ['failed', PROVIDER_REFUSED, true, true],
      ]);
      expect(await shown()).toMatchObject({
        run: ['needs_attention', PROVIDER_REFUSED],
        images: [
          ['failed', PROVIDER_REFUSED, 'provider_rejected', true],
          ['failed', PROVIDER_REFUSED, 'provider_rejected', true],
        ],
        // The steps after them stay in line for when they are retried.
        later: [['approval', 'queued', null], ['approval', 'queued', null], ['generation', 'queued', null]],
      });
      expect(logged('template_run_step_followed_its_generation')).toHaveLength(2);
      // Each failure was announced when the provider refused it, and is not announced twice.
      expect(announced).toHaveLength(2);
      expect(await notifications()).toEqual(announced);
      expect(await credits()).toBe(STARTING_CREDITS);

      // It is over: later passes find no ticket due.
      await delayPassed();
      expect(await process()).toMatchObject({ claimed: 0 });
      expect(startAnswers).toEqual([]);
    });

    it('tells the person its generation failed when nobody had', async () => {
      await startedOnceAndPutBackInLine();
      // The pass that put the rows back in line had not failed the steps, so it announced nothing.
      await admin.query('delete from public.mobile_notifications where user_id=$1', [userId]);

      await process();

      expect((await notifications()).map((row) => [row.type, row.body, row.deep_link, row.dedupe_key]).sort()).toEqual(
        (await generations()).map((generation) => [
          'generation_failed',
          'Open your template run to retry this step.',
          `/template-runs/${runId}`,
          `generation:${generation.id}:failed`,
        ]).sort(),
      );
    });

    it('is retried by hand as its next attempt, which starts', async () => {
      await startedOnceAndPutBackInLine();
      await process();

      for (const step of imageSteps) {
        await retryTemplateRunStep({ adminClient: client, runId, stepId: step.id, userId });
      }
      providerHasRoom();
      startAnswers.length = 0;
      expect(await process()).toMatchObject({ claimed: 1, deferred: 1 });

      expect(startAnswers).toEqual(['started', 'started']);
      expect(await imageAttempts()).toEqual([
        [[0, 'failed', 'failed'], [1, 'processing', 'processing']],
        [[0, 'failed', 'failed'], [1, 'processing', 'processing']],
      ]);
      expect((await run()).status).toBe('processing');
    });

    it('takes the result of a generation the provider accepted, and the run goes on', async () => {
      providerHasRoom();
      expect(await process()).toMatchObject({ claimed: 1, deferred: 1 });
      const held = await credits();
      await putBackInLine();
      await providerFinishesTheImages();
      startAnswers.length = 0;
      vi.mocked(fetch).mockClear();

      expect(await process()).toMatchObject({ claimed: 1, completed: 1 });

      // Nothing is started again: the results the person paid for are the steps' results.
      expect(startAnswers).toEqual([]);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(await imageAttempts()).toEqual([[[0, 'succeeded', 'succeeded']], [[0, 'succeeded', 'succeeded']]]);
      expect(await generations()).toHaveLength(2);
      expect(await credits()).toBe(held);
      // The run has reached its reviews.
      expect(await shown()).toMatchObject({
        run: ['awaiting_approval', null],
        later: [['approval', 'awaiting_approval', null], ['approval', 'awaiting_approval', null], ['generation', 'queued', null]],
      });
    });

    it('takes its generation back when its row has lost the link to it', async () => {
      providerHasRoom();
      expect(await process()).toMatchObject({ claimed: 1, deferred: 1 });
      const started = (await imageRows()).map((row) => row.generation_id);
      await putBackInLine();
      // The rows no longer name their generations, which still name the rows.
      await admin.query('update public.template_run_steps set generation_id=null where id = any($1)', [imageSteps.map((step) => step.id)]);
      await providerFinishesTheImages();
      startAnswers.length = 0;

      expect(await process()).toMatchObject({ claimed: 1, completed: 1 });

      expect(startAnswers).toEqual([]);
      expect(await imageAttempts()).toEqual([[[0, 'succeeded', 'succeeded']], [[0, 'succeeded', 'succeeded']]]);
      expect((await imageRows()).map((row) => row.generation_id)).toEqual(started);
    });

    it('follows a generation that is still running, and starts nothing beside it', async () => {
      providerHasRoom();
      expect(await process()).toMatchObject({ claimed: 1, deferred: 1 });
      const held = await credits();
      await putBackInLine();
      startAnswers.length = 0;
      vi.mocked(fetch).mockClear();

      expect(await process()).toMatchObject({ claimed: 1, deferred: 1 });

      expect(startAnswers).toEqual([]);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(await imageAttempts()).toEqual([[[0, 'processing', 'processing']], [[0, 'processing', 'processing']]]);
      expect(await generations()).toHaveLength(2);
      expect(await credits()).toBe(held);
      expect((await run()).status).toBe('processing');
      expect(await ticket()).toBe('pending');
    });
  });

  describe('a step the database refuses to start, with nothing behind it', () => {
    it('fails in the pass that meets the refusal, with no retry, when its row disagrees with what its node starts', async () => {
      // The rows say video, and the worker starts the image generations their nodes ask for.
      await admin.query("update public.template_run_steps set media_kind='video' where id = any($1)", [imageSteps.map((step) => step.id)]);

      expect(await process()).toMatchObject({ claimed: 1, completed: 1, deferred: 0, retried: 0 });

      expect(startAnswers).toEqual(['invalid_template_context', 'invalid_template_context']);
      expect(await ticket()).toBe('succeeded');
      expect(await run()).toEqual({ status: 'needs_attention', error_message: REFUSED_FOR_GOOD });
      expect(await shown()).toMatchObject({
        run: ['needs_attention', REFUSED_FOR_GOOD],
        // A retry is a new row for the same node, which would be refused as well.
        images: [
          ['failed', REFUSED_FOR_GOOD, 'provider_rejected', false],
          ['failed', REFUSED_FOR_GOOD, 'provider_rejected', false],
        ],
        // The steps after them are not failed with them.
        later: [['approval', 'queued', null], ['approval', 'queued', null], ['generation', 'queued', null]],
      });
      expect((await imageRows()).map((row) => row.finished)).toEqual([true, true]);
      // Nothing was ever held for them.
      expect(await generations()).toEqual([]);
      expect(await credits()).toBe(STARTING_CREDITS);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();

      // The person is told once for each step, and the operator's log says what the database answered.
      expect(await notifications()).toEqual(imageSteps.map((step) => `template-run:${runId}:step:${step.id}:refused`).sort()
        .map((dedupeKey) => ({
          type: 'generation_failed',
          category: 'generation',
          title: 'A step in your template run could not start',
          body: 'A problem on our side stopped it. Open the run to start a new one.',
          deep_link: `/template-runs/${runId}`,
          object_type: 'template_run',
          object_id: runId,
          dedupe_key: dedupeKey,
        })));
      expect(logged('template_run_step_start_refused').map((record) => [record.level, record.refusal, record.canRetry])).toEqual([
        ['error', 'invalid_template_context', false],
        ['error', 'invalid_template_context', false],
      ]);

      // The database is asked once, not on every pass.
      await delayPassed();
      expect(await process()).toMatchObject({ claimed: 0 });
      expect(startAnswers).toHaveLength(2);
      await expect(retryTemplateRunStep({ adminClient: client, runId, stepId: imageSteps[0].id, userId }))
        .rejects.toMatchObject({ status: 409, code: 'STEP_NOT_RETRYABLE' });
    });

    /** Another creation of the same person, which is no part of this run. */
    async function strayGeneration(values: { status: string; key?: string; stepId?: string }) {
      const id = randomUUID();
      await admin.query(
        `insert into public.generations(id,user_id,model,status,category,prompt,cost,refunded,client_request_key_hash,template_run_step_id)
         values($1,$2,'refused-start-fixture',$3,'image','fixture',4,$4,$5,$6)`,
        [id, userId, values.status, values.status === 'failed', values.key ?? null, values.stepId ?? null],
      );
      return id;
    }

    /** A row the database refuses for the generation on it or for its key, and the answer it gives. */
    const REFUSED_FOR_THE_ROW: Array<[string, (step: { id: string; node_id: string }) => Promise<void>, string]> = [
      ['its row names a generation that is not its own', async (step) => {
        const stray = await strayGeneration({ status: 'succeeded' });
        await admin.query('update public.template_run_steps set generation_id=$2 where id=$1', [step.id, stray]);
      }, 'template_step_already_started'],
      ['its request key belongs to another start that is over', async (step) => {
        await strayGeneration({ status: 'failed', key: requestKey(step.node_id) });
      }, 'key_already_used'],
      // A generation the run does not hold can never be followed to an end.
      ['the generation on its row belongs to no step of this run', async (step) => {
        const stray = await strayGeneration({ status: 'processing', stepId: step.id });
        await admin.query('update public.template_run_steps set generation_id=$2 where id=$1', [step.id, stray]);
      }, 'template_step_already_started'],
    ];

    it.each(REFUSED_FOR_THE_ROW)('fails with a retry when %s, and the retry starts', async (_shape, arrange, answer) => {
      const [refused] = imageSteps;
      await arrange(refused);
      providerHasRoom();

      expect(await process()).toMatchObject({ claimed: 1, completed: 1 });

      // The other image step starts as usual.
      expect([...startAnswers].sort()).toEqual([answer, 'started'].sort());
      expect(await shown()).toMatchObject({
        run: ['needs_attention', REFUSED],
        images: [
          ['failed', REFUSED, 'provider_rejected', true],
          ['processing', null, null, false],
        ],
      });
      expect(await notifications()).toEqual([{
        type: 'generation_failed',
        category: 'generation',
        title: 'A step in your template run could not start',
        body: 'A problem on our side stopped it. Open the run to retry the step.',
        deep_link: `/template-runs/${runId}`,
        object_type: 'template_run',
        object_id: runId,
        dedupe_key: `template-run:${runId}:step:${refused.id}:refused`,
      }]);
      expect(logged('template_run_step_start_refused').map((record) => [record.stepId, record.refusal, record.canRetry])).toEqual([
        [refused.id, answer, true],
      ]);

      // A retry is a new row with a new request key, which the database starts.
      await retryTemplateRunStep({ adminClient: client, runId, stepId: refused.id, userId });
      startAnswers.length = 0;
      expect(await process()).toMatchObject({ claimed: 1, deferred: 1 });

      expect(startAnswers).toEqual(['started']);
      expect((await imageAttempts())[0].map(([attempt, status]) => [attempt, status])).toEqual([
        [0, 'failed'],
        [1, 'processing'],
      ]);
    });
  });

  describe('a step two passes of the worker reach at once', () => {
    /** The other pass's start of a step's row, with the key every pass sends for it. */
    async function otherPassStarts(step: { id: string; node_id: string }) {
      const { rows } = await other.query(
        `select public.start_template_generation(
           p_user_id=>$1, p_template_run_id=>$2, p_template_run_step_id=>$3, p_cost=>4, p_model=>'nano-banana-2',
           p_category=>'image', p_duration=>null, p_creation_mode=>null, p_source_generation_id=>null,
           p_client_request_key_hash=>$4) as result`,
        [userId, runId, step.id, requestKey(step.node_id)],
      );
      expect(rows[0].result.status).toBe('started');
      return rows[0].result.generation_id as string;
    }

    /**
     * Runs a pass of this worker with something else getting in between its
     * read of the run and its first start.
     *
     * The other connection holds the run's row, which every start takes
     * first. The pass reads the run as it stands, reaches its first start and
     * waits there. `meanwhile` then happens on the other connection, and its
     * commit lets the pass's start through to what it left.
     */
    async function passWith(meanwhile: () => Promise<void>) {
      await other.query('begin');
      await other.query('select 1 from public.template_runs where id=$1 for update', [runId]);
      const running = process();
      for (let waited = 0; ; waited += 1) {
        const { rows } = await admin.query(
          "select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",
          [workerPid],
        );
        if (rows.length) break;
        // Ten seconds, for a runner that is busy with other work.
        if (waited === 400) throw new Error('The pass never reached its first start.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await meanwhile();
      await other.query('commit');
      return running;
    }

    const quiet = async () => ({
      told: await notifications(),
      refused: logged('template_run_step_start_refused'),
      followed: logged('template_run_step_followed_its_generation'),
    });

    it('is left to the pass that started it first', async () => {
      providerHasRoom();
      const started: string[] = [];

      const summary = await passWith(async () => {
        for (const step of imageSteps) started.push(await otherPassStarts(step));
      });

      expect(summary).toMatchObject({ claimed: 1, deferred: 1, retried: 0 });

      expect(startAnswers).toEqual(['in_progress', 'in_progress']);
      // One generation for each row, and it is the other pass's.
      expect((await imageRows()).map((row) => [row.status, row.error_message, row.generation_id])).toEqual([
        ['processing', null, started[0]],
        ['processing', null, started[1]],
      ]);
      expect(await generations()).toHaveLength(2);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect((await run()).status).toBe('processing');
      expect(await quiet()).toEqual({ told: [], refused: [], followed: [] });
    }, 20_000);

    it('is left as the other pass ended it when that pass had its start refused meanwhile', async () => {
      providerHasRoom();

      // The other pass starts each row, the provider refuses it, and that pass
      // fails the step, all before this pass's start arrives.
      await passWith(async () => {
        for (const step of imageSteps) {
          const generationId = await otherPassStarts(step);
          await other.query(
            'select public.settle_template_generation_start_failed($1, $2)',
            [generationId, 'What the other pass wrote.'],
          );
        }
      });

      expect(startAnswers).toEqual(['template_step_already_started', 'template_step_already_started']);
      // This pass wrote nothing over it, and told nobody: the step is the other pass's to announce.
      expect((await imageRows()).map((row) => [row.status, row.error_message, row.can_retry])).toEqual([
        ['failed', 'What the other pass wrote.', true],
        ['failed', 'What the other pass wrote.', true],
      ]);
      expect(await credits()).toBe(STARTING_CREDITS);
      expect(await quiet()).toEqual({ told: [], refused: [], followed: [] });
    }, 20_000);

    it('is left alone when the person cancels the run under the pass', async () => {
      providerHasRoom();

      // The cancel has written the run and not yet its steps.
      await passWith(async () => {
        await other.query("update public.template_runs set status='cancelled', completed_at=now() where id=$1", [runId]);
      });

      expect(startAnswers).toEqual(['invalid_template_context', 'invalid_template_context']);
      // The cancel marks the steps itself.
      expect((await imageRows()).map((row) => [row.status, row.error_message, row.can_retry, row.finished])).toEqual([
        ['queued', null, true, false],
        ['queued', null, true, false],
      ]);
      expect((await run()).status).toBe('cancelled');
      expect(await quiet()).toEqual({ told: [], refused: [], followed: [] });
    }, 20_000);
  });
});
