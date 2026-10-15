import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTemplateRunDatabase,
  TEMPLATE_RUN_ID,
  TEMPLATE_RUN_USER_ID,
  type TemplateRunDatabase,
} from '@/__tests__/fixtures/template-run-database';
import { setBackendLogSink } from '@/lib/backend-logger';
import {
  createTemplateRunCancelRouteHandlers,
  createTemplateRunRouteHandlers,
  createTemplateRunStepApprovalRouteHandlers,
} from '@/lib/media-template-route-adapter-service';
import {
  approveTemplateRunStep,
  cancelTemplateRun,
  createTemplateInputUploadIntent,
  finalizeTemplateRunInputs,
  getTemplateRun,
  retryTemplateRunStep,
  startTemplateRun,
} from '@/lib/template-run-service';

// The provider key is read once, when the generation modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
});

// No worker runs here: what is asserted is whether one was asked for.
const worker = vi.hoisted(() => ({ asked: vi.fn(async () => 'job-1') }));
vi.mock('@/lib/template-run-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/template-run-jobs')>()),
  enqueueTemplateRunJob: worker.asked,
}));

// Asking the provider about a generation is the status sync's work.
vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: async () => undefined,
}));

// The routes are called as `route.userId`, with the database the run lives in.
const route = vi.hoisted(() => ({ client: null as unknown, userId: '' }));
vi.mock('@/lib/media-template-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media-template-api')>()),
  getTemplateApiAuth: async () => ({ userClient: null, adminClient: route.client, userId: route.userId }),
}));
vi.mock('@/lib/backend-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend-rate-limit')>()),
  enforceBackendRateLimit: async () => undefined,
}));

// In this file the run's owner, `user-1` in the fixture, is a guest (D4), and
// signing in links it to ACCOUNT_ID, as `merge_guest_account` does: the guest's
// profile names the account, and every row the guest made keeps the guest's id.
const GUEST_ID = TEMPLATE_RUN_USER_ID;
const ACCOUNT_ID = 'account-1';
/** The fixture names its steps `step-<n>`. */
const FIRST_STEP_ID = 'step-1';
const NOW = '2026-10-15T18:00:00.000Z';
const NOT_FOUND = { status: 404, code: 'RUN_NOT_FOUND', message: 'Template run not found.' };
const OWNER_ONLY = {
  status: 409,
  code: 'RUN_FROM_LINKED_GUEST',
  message: 'Runs started before you signed in can only be viewed or cancelled. Start a new run to try the template again.',
};

describe('a guest\'s template run after the guest signs in', () => {
  let database: TemplateRunDatabase;
  let restoreLogSink: () => void;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Nothing here may reach the network.');
    }));
    restoreLogSink = setBackendLogSink(() => undefined);
    worker.asked.mockClear();
    database = createTemplateRunDatabase();
    route.client = database.client;
  });
  afterEach(() => {
    restoreLogSink();
    vi.unstubAllGlobals();
    route.client = null;
    route.userId = '';
  });

  async function linkGuestToAccount() {
    const { error } = await database.client.from('profiles')
      .update({ merged_into_user_id: ACCOUNT_ID })
      .eq('id', GUEST_ID);
    expect(error).toBeNull();
  }

  const read = (userId: string, client: SupabaseClient = database.client) => (
    getTemplateRun({ adminClient: client, runId: TEMPLATE_RUN_ID, userId })
  );
  const rows = () => structuredClone({
    run: database.run,
    steps: database.steps,
    generations: database.generations,
  });

  /** The client, with each table a query was made on written down. */
  function recordingTables(base: SupabaseClient) {
    const asked: string[] = [];
    const client = {
      ...base,
      from(table: string) {
        asked.push(table);
        return base.from(table);
      },
    } as unknown as SupabaseClient;
    return { client, asked };
  }

  /** The run finished, its one video step's output its result. */
  function finishRun() {
    const [step] = database.steps;
    const output = `generated_videos/${GUEST_ID}/result.mp4`;
    database.generations.push({
      id: 'gen-1',
      user_id: GUEST_ID,
      status: 'succeeded',
      prediction_id: 'task-gen-1',
      output_url: output,
      error_message: null,
      cost: step.estimated_credits,
      actual_cost: step.estimated_credits,
      template_run_id: TEMPLATE_RUN_ID,
      template_run_step_id: step.id,
      studio_visible: true,
      created_at: NOW,
      completed_at: NOW,
    });
    Object.assign(step, { status: 'succeeded', generation_id: 'gen-1', output_url: output, started_at: NOW, finished_at: NOW });
    Object.assign(database.run, {
      status: 'succeeded',
      result_url: output,
      result_generation_id: 'gen-1',
      estimated_remaining_credits: 0,
      completed_at: NOW,
    });
  }

  describe('reading it', () => {
    it('is the account\'s once the guest is linked to it, and stays the guest\'s run', async () => {
      // Before the link the account is anyone else.
      await expect(read(ACCOUNT_ID)).rejects.toMatchObject(NOT_FOUND);

      await linkGuestToAccount();
      const run = await read(ACCOUNT_ID);

      expect(run).toMatchObject({ id: TEMPLATE_RUN_ID, userId: GUEST_ID, status: 'queued' });
      expect(database.run.user_id).toBe(GUEST_ID);
    });

    it('costs its own identity no lookup of linked identities', async () => {
      const { client, asked } = recordingTables(database.client);

      expect((await read(GUEST_ID, client)).id).toBe(TEMPLATE_RUN_ID);
      expect(asked).not.toContain('profiles');
      expect(asked.filter((table) => table === 'template_runs')).toHaveLength(1);
    });

    it('is "not found" to an account the guest was not linked to', async () => {
      await linkGuestToAccount();

      await expect(read('account-2')).rejects.toMatchObject(NOT_FOUND);
      await expect(read('guest-2')).rejects.toMatchObject(NOT_FOUND);
    });

    it('is "not found" to the account when its linked identities cannot be read', async () => {
      await linkGuestToAccount();
      const client = {
        ...database.client,
        from(table: string) {
          if (table === 'profiles') throw new Error('canceling statement due to statement timeout');
          return database.client.from(table);
        },
      } as unknown as SupabaseClient;

      await expect(read(ACCOUNT_ID, client)).rejects.toMatchObject(NOT_FOUND);
    });

    // A guest cannot post: a post made from the result is the account's.
    it.each([
      ['the account', ACCOUNT_ID, { id: 'post-1', visibility: 'public' }],
      ['anyone else', 'someone-else', null],
    ])('names the post %s made from the result', async (_label, author, linkedPost) => {
      finishRun();
      database.posts.push({
        id: 'post-1',
        user_id: author,
        generation_id: 'gen-1',
        visibility: 'public',
        archived_at: null,
        tombstoned_at: null,
      });
      await linkGuestToAccount();

      const run = await read(ACCOUNT_ID);

      expect(run.result).toMatchObject({ generationId: 'gen-1', linkedPost });
    });
  });

  it('may be cancelled by the account, and the run stays the guest\'s', async () => {
    await linkGuestToAccount();
    const uploads = Object.values(database.run.input_storage_paths as Record<string, string>)
      .map((value) => value.replace(/^template_inputs\//, '')).sort();
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.every((path) => path.startsWith(`${GUEST_ID}/`))).toBe(true);

    const shown = await cancelTemplateRun(database.client, TEMPLATE_RUN_ID, ACCOUNT_ID);

    expect(shown.status).toBe('cancelled');
    expect(database.run).toMatchObject({ user_id: GUEST_ID, status: 'cancelled', input_storage_paths: {} });
    expect(database.steps.map((step) => step.status)).toEqual(database.steps.map(() => 'cancelled'));
    expect(database.removedInputs.sort()).toEqual(uploads);
    expect(worker.asked).not.toHaveBeenCalled();
  });

  it('stays "not found" to anyone else\'s cancel', async () => {
    await linkGuestToAccount();
    const before = rows();

    await expect(cancelTemplateRun(database.client, TEMPLATE_RUN_ID, 'account-2')).rejects.toMatchObject(NOT_FOUND);

    expect(rows()).toEqual(before);
  });

  // Each sets paid work going that is charged to the run's owner, whose credits
  // the link moved to the account, or keeps an upload under the owner's id.
  describe('the guest\'s own actions', () => {
    const actions: Array<[string, (userId: string) => Promise<unknown>]> = [
      ['start', (userId) => startTemplateRun({ adminClient: database.client, runId: TEMPLATE_RUN_ID, userId })],
      ['upload an input', (userId) => createTemplateInputUploadIntent({
        body: { slotKey: 'any' },
        client: database.client,
        runId: TEMPLATE_RUN_ID,
        userId,
      })],
      ['finish the uploads', (userId) => finalizeTemplateRunInputs({
        body: { inputs: [] },
        client: database.client,
        runId: TEMPLATE_RUN_ID,
        userId,
      })],
      ['approve', (userId) => approveTemplateRunStep({
        adminClient: database.client,
        runId: TEMPLATE_RUN_ID,
        stepId: FIRST_STEP_ID,
        userId,
      })],
      ['retry', (userId) => retryTemplateRunStep({
        adminClient: database.client,
        runId: TEMPLATE_RUN_ID,
        stepId: FIRST_STEP_ID,
        userId,
      })],
    ];

    it.each(actions)('cannot %s for the account, which is told why, and nothing changes', async (_label, act) => {
      await linkGuestToAccount();
      const before = rows();

      await expect(act(ACCOUNT_ID)).rejects.toMatchObject(OWNER_ONLY);

      expect(rows()).toEqual(before);
      expect(database.rpcCalls).toEqual([]);
      expect(database.removedInputs).toEqual([]);
      expect(worker.asked).not.toHaveBeenCalled();
    });

    it.each(actions)('cannot %s for anyone else, who is told the run does not exist', async (_label, act) => {
      await linkGuestToAccount();
      const before = rows();

      await expect(act('account-2')).rejects.toMatchObject(NOT_FOUND);

      expect(rows()).toEqual(before);
      expect(database.rpcCalls).toEqual([]);
    });
  });

  describe('through the routes', () => {
    const request = (requestPath: string, method: 'GET' | 'POST') => (
      new Request(`https://magicbooklet.com${requestPath}`, { method })
    );

    it('reads the run for the account', async () => {
      await linkGuestToAccount();
      route.userId = ACCOUNT_ID;

      const response = await createTemplateRunRouteHandlers().GET(
        request(`/api/template-runs/${TEMPLATE_RUN_ID}`, 'GET'),
        { params: Promise.resolve({ id: TEMPLATE_RUN_ID }) },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ run: { id: TEMPLATE_RUN_ID, userId: GUEST_ID } });
    });

    it('cancels the run for the account', async () => {
      await linkGuestToAccount();
      route.userId = ACCOUNT_ID;

      const response = await createTemplateRunCancelRouteHandlers().POST(
        request(`/api/template-runs/${TEMPLATE_RUN_ID}/cancel`, 'POST'),
        { params: Promise.resolve({ id: TEMPLATE_RUN_ID }) },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ run: { id: TEMPLATE_RUN_ID, status: 'cancelled' } });
    });

    it('answers the account\'s approval 409 with the reason, and starts no worker', async () => {
      await linkGuestToAccount();
      route.userId = ACCOUNT_ID;
      const scheduleAfter = vi.fn();

      const response = await createTemplateRunStepApprovalRouteHandlers({ scheduleAfter }).POST(
        request(`/api/template-runs/${TEMPLATE_RUN_ID}/approval-steps/step-1/approve`, 'POST'),
        { params: Promise.resolve({ id: TEMPLATE_RUN_ID, stepId: 'step-1' }) },
      );

      expect(response.status).toBe(409);
      // Both clients show `error` to the person as it is.
      expect(await response.json()).toEqual({ error: OWNER_ONLY.message, code: OWNER_ONLY.code });
      expect(scheduleAfter).not.toHaveBeenCalled();
      expect(worker.asked).not.toHaveBeenCalled();
    });
  });
});
