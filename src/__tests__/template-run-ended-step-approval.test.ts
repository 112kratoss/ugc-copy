import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  withUniqueDedupeKeys,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import {
  createTemplateRunDatabase,
  TEMPLATE_RUN_ID,
  TEMPLATE_RUN_USER_ID,
  type TemplateRunDatabase,
} from '@/__tests__/fixtures/template-run-database';
import { setBackendLogSink } from '@/lib/backend-logger';
import { createTemplateRunStepApprovalRouteHandlers } from '@/lib/media-template-route-adapter-service';
import { MediaTemplateError } from '@/lib/media-template-types';
import {
  abandonTemplateRun,
  approveTemplateRunStep,
  cancelTemplateRun,
  retryTemplateRunStep,
  TEMPLATE_RUN_ABANDONED_MESSAGE,
} from '@/lib/template-run-service';

// The provider key is read once, when the generation modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
});

// An approval that goes through asks for a worker. None runs here: what is
// asserted is whether one was asked for.
const worker = vi.hoisted(() => ({ asked: vi.fn(async () => 'job-1') }));
vi.mock('@/lib/template-run-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/template-run-jobs')>()),
  enqueueTemplateRunJob: worker.asked,
}));

vi.mock('@/lib/server-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server-helpers')>()),
  resolveOwnedStoredMediaUrl: async (_client: unknown, value: string) => `signed:${value}`,
}));

// The route is called as the person the run belongs to, with the database the
// run lives in. Its rate limit is a database function of its own.
const route = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/media-template-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media-template-api')>()),
  getTemplateApiAuth: async () => ({ userClient: null, adminClient: route.client, userId: TEMPLATE_RUN_USER_ID }),
}));
vi.mock('@/lib/backend-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend-rate-limit')>()),
  enforceBackendRateLimit: async () => undefined,
}));

type Row = Record<string, unknown>;
type WritableQuery = { update: (values: Row) => unknown; insert: (values: Row | Row[]) => unknown };

const NOW = '2026-10-03T09:00:00.000Z';
/** Half an hour on: nothing has written the run since the give-up time began. */
const IDLE_BEFORE = '2026-10-03T09:30:00.000Z';
const RUN_ENDED = {
  status: 409,
  code: 'RUN_TERMINAL',
  message: 'This run has ended. Start a new run to try the template again.',
};
/**
 * The run row as each ending leaves it: the worker giving up on the run, the
 * person cancelling it, and its last step finishing. A run that succeeded has
 * no step left waiting. It is listed so that an approval is refused wherever
 * a retry is, on every status a run ends with.
 */
const ENDED: Record<'failed' | 'cancelled' | 'succeeded', Row> = {
  failed: {
    status: 'failed',
    completed_at: NOW,
    error_message: TEMPLATE_RUN_ABANDONED_MESSAGE,
    input_storage_paths: {},
    inputs_deleted_at: NOW,
  },
  cancelled: { status: 'cancelled', completed_at: NOW, error_message: null, input_storage_paths: {}, inputs_deleted_at: NOW },
  succeeded: { status: 'succeeded', completed_at: NOW, error_message: null, input_storage_paths: {}, inputs_deleted_at: NOW },
};
const ENDED_STATUSES = ['failed', 'cancelled', 'succeeded'] as const;

describe('approving a checkpoint of a template run that has ended', () => {
  let database: TemplateRunDatabase;
  let history: MobileNotificationHistory;
  let client: SupabaseClient;
  let restoreLogSink: () => void;

  beforeEach(() => {
    // Only the clock is faked: the run and what is written to it are stamped with it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Nothing here may reach the network.');
    }));
    restoreLogSink = setBackendLogSink(() => undefined);
    worker.asked.mockClear();
    database = createTemplateRunDatabase();
    history = withUniqueDedupeKeys(createMobileNotificationHistory());
    client = withNotifications(database.client);
    route.client = client;
  });
  afterEach(() => {
    restoreLogSink();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    route.client = null;
  });

  /** The run's tables and storage, with the notification tables served by the history. */
  function withNotifications(base: SupabaseClient) {
    return {
      ...base,
      from: (table: string) => (history.handles(table) ? history.from(table) : base.from(table)),
    } as unknown as SupabaseClient;
  }

  /**
   * The run as a pass of the worker leaves it once both images are in: each
   * waits at its checkpoint for the person, and the video waits on both.
   * Returns the two checkpoints.
   */
  function imagesAwaitApproval() {
    const { edges } = (database.run.graph_snapshot as { graph: { edges: Array<{ source: string; target: string }> } }).graph;
    const gates = database.steps.filter((step) => step.kind === 'approval');
    for (const gate of gates) {
      const image = database.steps.find((step) => (
        edges.some((edge) => edge.source === step.node_id && edge.target === gate.node_id)
      ))!;
      const id = `gen-${database.generations.length + 1}`;
      const outputUrl = `generated_images/${TEMPLATE_RUN_USER_ID}/${id}.png`;
      database.generations.push({
        id,
        user_id: TEMPLATE_RUN_USER_ID,
        status: 'succeeded',
        prediction_id: `task-${id}`,
        output_url: outputUrl,
        error_message: null,
        cost: image.estimated_credits,
        actual_cost: image.estimated_credits,
        template_run_id: TEMPLATE_RUN_ID,
        template_run_step_id: image.id,
        created_at: NOW,
        completed_at: NOW,
      });
      Object.assign(image, { status: 'succeeded', generation_id: id, output_url: outputUrl, started_at: NOW, finished_at: NOW });
      Object.assign(gate, { status: 'awaiting_approval', output_url: outputUrl, started_at: NOW });
    }
    database.run.status = 'awaiting_approval';
    return gates;
  }

  const approve = (step: Row, adminClient: SupabaseClient = client) => approveTemplateRunStep({
    adminClient,
    runId: TEMPLATE_RUN_ID,
    stepId: String(step.id),
    userId: TEMPLATE_RUN_USER_ID,
  });
  /** What the approval was refused with, or null when it went through. */
  const refusal = (step: Row, adminClient?: SupabaseClient) => approve(step, adminClient).then(() => null, (error: unknown) => error);
  /** Every row an approval could change. */
  const rows = () => structuredClone({ run: database.run, steps: database.steps, generations: database.generations });
  const stepStates = () => database.steps.map((step) => [step.kind, step.media_kind, step.status]);

  /** Every write the service asks the run's tables for, whether or not a row matched it. */
  function recordingWrites(base: SupabaseClient) {
    const writes: Array<[table: string, values: Row | Row[]]> = [];
    const recording = {
      ...base,
      from(table: string) {
        const query = base.from(table) as unknown as WritableQuery;
        const { update, insert } = query;
        query.update = (values) => {
          writes.push([table, values]);
          return update.call(query, values);
        };
        query.insert = (values) => {
          writes.push([table, values]);
          return insert.call(query, values);
        };
        return query;
      },
    } as unknown as SupabaseClient;
    return { client: recording, writes };
  }

  /**
   * The run's tables, where the write that closes the steps of an ending run
   * does not land. The database answers it with an error, which is returned
   * to the caller and not thrown.
   */
  function losingTheWriteThatClosesSteps(base: SupabaseClient) {
    const lost = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    const unanswered = {
      eq: () => unanswered,
      in: () => unanswered,
      then: <T>(resolve: (value: typeof lost) => T) => Promise.resolve(lost).then(resolve),
    };
    return {
      ...base,
      from(table: string) {
        const query = base.from(table) as unknown as WritableQuery;
        if (table !== 'template_run_steps') return query;
        const { update } = query;
        query.update = (values) => (values.status === 'cancelled' ? unanswered : update.call(query, values));
        return query;
      },
    } as unknown as SupabaseClient;
  }

  /** The run's tables, where the run ends just as an approval that has read it makes its first write. */
  function endingTheRunAtTheFirstWrite(base: SupabaseClient, end: () => void) {
    let ended = false;
    return {
      ...base,
      rpc(fn: string, args: Record<string, unknown>) {
        if (fn === 'approve_template_checkpoint' && !ended) {
          ended = true;
          end();
        }
        return base.rpc(fn, args);
      },
      from(table: string) {
        const query = base.from(table) as unknown as WritableQuery;
        const { update } = query;
        query.update = (values) => {
          if (!ended) {
            ended = true;
            end();
          }
          return update.call(query, values);
        };
        return query;
      },
    } as unknown as SupabaseClient;
  }

  it.each(ENDED_STATUSES)(
    'refuses a checkpoint that still reads as waiting on a run that is %s, before anything is written',
    async (status) => {
      const [gate] = imagesAwaitApproval();
      // The run ended, and the write that closes its waiting steps did not land.
      Object.assign(database.run, ENDED[status]);
      const before = rows();
      const recorded = recordingWrites(client);

      const refused = await refusal(gate, recorded.client);

      // The route answers a MediaTemplateError with its own status. Anything else is a 500.
      expect(refused).toBeInstanceOf(MediaTemplateError);
      expect(refused).toMatchObject(RUN_ENDED);
      expect(recorded.writes).toEqual([]);
      expect(worker.asked).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
    },
  );

  it('refuses the checkpoints a cancelled run keeps when the write that closes its steps is lost', async () => {
    const gates = imagesAwaitApproval();
    const uploads = Object.values(database.run.input_storage_paths as Record<string, string>);

    const cancelled = await cancelTemplateRun(losingTheWriteThatClosesSteps(client), TEMPLATE_RUN_ID, TEMPLATE_RUN_USER_ID);

    // The run is over and its uploads are gone, and both checkpoints still wait.
    expect(cancelled.status).toBe('cancelled');
    expect(database.removedInputs).toHaveLength(uploads.length);
    expect(stepStates()).toEqual([
      ['generation', 'image', 'succeeded'],
      ['generation', 'image', 'succeeded'],
      ['approval', 'image', 'awaiting_approval'],
      ['approval', 'image', 'awaiting_approval'],
      ['generation', 'video', 'queued'],
    ]);
    const before = rows();

    for (const gate of gates) expect(await refusal(gate)).toMatchObject(RUN_ENDED);

    expect(rows()).toEqual(before);
    expect(worker.asked).not.toHaveBeenCalled();
  });

  it('refuses the checkpoints a run the worker gave up on keeps when the write that closes its steps is lost', async () => {
    const gates = imagesAwaitApproval();
    // The pass that put the checkpoints up for review failed before it wrote
    // the run's progress, and so did every pass after it.
    database.run.status = 'processing';

    expect(await abandonTemplateRun({
      client: losingTheWriteThatClosesSteps(client),
      runId: TEMPLATE_RUN_ID,
      userId: TEMPLATE_RUN_USER_ID,
      idleBefore: IDLE_BEFORE,
    })).toBe(true);

    // The run has stopped, its uploads are gone and the person was told so,
    // and both checkpoints still wait with the video in line behind them.
    expect(database.run).toMatchObject(ENDED.failed);
    expect(history.sent.map((notification) => notification.title)).toEqual(['Your template run stopped']);
    expect(stepStates()).toEqual([
      ['generation', 'image', 'succeeded'],
      ['generation', 'image', 'succeeded'],
      ['approval', 'image', 'awaiting_approval'],
      ['approval', 'image', 'awaiting_approval'],
      ['generation', 'video', 'queued'],
    ]);
    const before = rows();

    for (const gate of gates) expect(await refusal(gate)).toMatchObject(RUN_ENDED);

    // Approved, the two checkpoints would let the video start on a run that has stopped.
    expect(rows()).toEqual(before);
    expect(worker.asked).not.toHaveBeenCalled();
    expect(history.sent).toHaveLength(1);
  });

  it('says the run has ended for a checkpoint the run closed, in the words a retry is refused with', async () => {
    const [gate] = imagesAwaitApproval();
    // The person cancelled the run on another device, and this screen still offers the checkpoint.
    await cancelTemplateRun(client, TEMPLATE_RUN_ID, TEMPLATE_RUN_USER_ID);
    expect(gate.status).toBe('cancelled');

    const refused = await refusal(gate);
    const retryRefused = await retryTemplateRunStep({
      adminClient: client,
      runId: TEMPLATE_RUN_ID,
      stepId: String(gate.id),
      userId: TEMPLATE_RUN_USER_ID,
    }).then(() => null, (error: unknown) => error);

    expect(refused).toMatchObject(RUN_ENDED);
    expect(retryRefused).toMatchObject(RUN_ENDED);
  });

  it.each(ENDED_STATUSES)(
    'leaves a run %s that ended after the approval had read it',
    async (status) => {
      const [gate] = imagesAwaitApproval();
      database.run.status = 'processing';
      // The run's own row is written first by whatever ends it. Its steps are closed after that.
      const racing = endingTheRunAtTheFirstWrite(client, () => Object.assign(database.run, ENDED[status]));

      const refused = await refusal(gate, racing);

      // The transaction rechecks the run and leaves the checkpoint unchanged.
      expect(database.run).toMatchObject(ENDED[status]);
      expect(refused).toMatchObject(RUN_ENDED);
      expect(gate.status).toBe('awaiting_approval');
    },
  );

  it.each(['awaiting_approval', 'processing', 'queued', 'needs_attention'] as const)(
    'approves a waiting checkpoint of a run that is %s and sets the run going',
    async (status) => {
      const [gate, other] = imagesAwaitApproval();
      Object.assign(database.run, { status, error_message: status === 'needs_attention' ? 'A workflow step needs another try.' : null });

      const shown = await approve(gate);

      expect(gate).toMatchObject({ status: 'succeeded', approved_at: NOW, finished_at: NOW, error_message: null });
      expect(other.status).toBe('awaiting_approval');
      expect(database.run).toMatchObject({ status: 'processing', error_message: null, completed_at: null });
      expect(database.rpcCalls.filter(call => call.fn === 'approve_template_checkpoint')).toHaveLength(1);
      expect(worker.asked).not.toHaveBeenCalled(); // The SQL transaction enqueues.
      expect(shown.status).toBe('processing');
      expect(shown.steps.find((step) => step.id === gate.id)?.status).toBe('succeeded');
    },
  );

  describe('through the approve route', () => {
    const post = (gate: Row, scheduleAfter: () => void) => createTemplateRunStepApprovalRouteHandlers({ scheduleAfter }).POST(
      new Request(
        `https://magicbooklet.com/api/template-runs/${TEMPLATE_RUN_ID}/approval-steps/${String(gate.id)}/approve`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: TEMPLATE_RUN_ID, stepId: String(gate.id) }) },
    );

    it('answers 409 with the reason for a run that has ended, and starts no worker', async () => {
      const [gate] = imagesAwaitApproval();
      Object.assign(database.run, ENDED.failed);
      const scheduleAfter = vi.fn();

      const response = await post(gate, scheduleAfter);

      expect(response.status).toBe(409);
      // Both clients show `error` to the person as it is.
      expect(await response.json()).toEqual({ error: RUN_ENDED.message, code: RUN_ENDED.code });
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(scheduleAfter).not.toHaveBeenCalled();
      expect(worker.asked).not.toHaveBeenCalled();
    });

    it('answers with the run and starts a worker for a run still in progress', async () => {
      const [gate] = imagesAwaitApproval();
      const scheduleAfter = vi.fn();

      const response = await post(gate, scheduleAfter);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ run: { id: TEMPLATE_RUN_ID, status: 'processing' } });
      expect(scheduleAfter).toHaveBeenCalledTimes(1);
    });
  });
});
