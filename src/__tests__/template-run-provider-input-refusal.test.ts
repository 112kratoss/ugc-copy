import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTemplateRunDatabase,
  TEMPLATE_RUN_ID,
  TEMPLATE_RUN_USER_ID,
  type TemplateRunDatabase,
} from '@/__tests__/fixtures/template-run-database';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { startImageGeneration, type TemplateGenerationContext } from '@/lib/generation-services';
import { PROVIDER_INPUT_REFUSED_MESSAGE } from '@/lib/generation-public-failure';
import { getTemplateRun, retryTemplateRunStep, syncTemplateRun } from '@/lib/template-run-service';

// The provider key and the callback settings are read when the generation
// modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
  vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'test-webhook-secret');
  vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'hmac-key');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
});

vi.mock('@/lib/server-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server-helpers')>()),
  createServiceClient: () => {
    throw new Error('Nothing is held, so nothing needs the service client.');
  },
  resolveOwnedStoredMediaUrl: async (_client: unknown, value: string) => `signed:${value}`,
}));

vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: async () => undefined,
}));

type StepStart = {
  supabase: SupabaseClient;
  userId: string;
  clientRequestKeyHash?: string | null;
  persistInputMedia?: boolean;
  privateRecipe?: boolean;
  templateContext?: TemplateGenerationContext;
};

// The run worker is under test with the real image start. The node executor is
// stood in for by what it does for an image step, whose template prompt is one
// character past what Z-Image takes (z-image/z-image: 1,000), so the start
// refuses it before its hold as POST /api/generations does.
vi.mock('@/lib/workflow-runner', () => ({
  executeWorkflowRunnableNode: async (params: StepStart) => {
    const started = await startImageGeneration({
      supabase: params.supabase,
      creditSupabase: params.supabase,
      userId: params.userId,
      prompt: 'a'.repeat(1001),
      model: 'z-image',
      clientRequestKeyHash: params.clientRequestKeyHash,
      persistInputMedia: params.persistInputMedia,
      privateRecipe: params.privateRecipe,
      templateContext: params.templateContext,
    });
    return {
      status: 'processing',
      generation_id: started.generationId ?? null,
      input_snapshot: {},
      output_snapshot: {},
      error_message: null,
    };
  },
}));

const STARTING_CREDITS = 100;

let logs: BackendLogRecord[] = [];
let restoreLogSink: () => void = () => undefined;

beforeEach(() => {
  logs = [];
  restoreLogSink = setBackendLogSink((record) => logs.push(record));
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  restoreLogSink();
  vi.unstubAllGlobals();
});

function pass(database: TemplateRunDatabase) {
  return syncTemplateRun({ adminClient: database.client, runId: TEMPLATE_RUN_ID, userId: TEMPLATE_RUN_USER_ID });
}

/** The image steps as the person sees them: status, message, failure code and whether a retry is offered. */
async function shownImageSteps(database: TemplateRunDatabase) {
  const ids = database.imageSteps().map((step) => step.id);
  const run = await getTemplateRun({ adminClient: database.client, runId: TEMPLATE_RUN_ID, userId: TEMPLATE_RUN_USER_ID });
  return run.steps.filter((step) => ids.includes(step.id))
    .map((step) => [step.status, step.errorMessage, step.failureCode, step.canRetry]);
}

describe('a template step refused for what its provider would refuse', () => {
  it('ends a published template’s step under copy that keeps its recipe private', async () => {
    const database = createTemplateRunDatabase({ credits: STARTING_CREDITS });

    const run = await pass(database);

    // Studio shows a template result's model as `template-workflow` and never its prompt:
    // the refusal names the model and its limit, so the person running it reads neither.
    expect(await shownImageSteps(database)).toEqual([
      ['failed', PROVIDER_INPUT_REFUSED_MESSAGE, 'provider_rejected', false],
      ['failed', PROVIDER_INPUT_REFUSED_MESSAGE, 'provider_rejected', false],
    ]);
    expect(run.status).toBe('needs_attention');
    const shown = JSON.stringify(await getTemplateRun({
      adminClient: database.client, runId: TEMPLATE_RUN_ID, userId: TEMPLATE_RUN_USER_ID,
    }));
    expect(shown).not.toMatch(/z-image|1,000|characters/i);
    // Refused before the hold: nothing reserved, nothing sent.
    expect(database.starts()).toEqual([]);
    expect(database.credits()).toBe(STARTING_CREDITS);
    expect(fetch).not.toHaveBeenCalled();
    // What was refused is kept where the template's owner can be told of it.
    expect(logs.filter((log) => log.msg === 'template_run_step_input_refused')).toEqual(
      database.imageSteps().map((step) => expect.objectContaining({
        level: 'warn',
        runId: TEMPLATE_RUN_ID,
        stepId: step.id,
        isTest: false,
        errorMessage: 'Z-Image prompts support up to 1,000 characters.',
      })),
    );
  });

  it('tells the creator, on a test run of their own draft, which model refuses what', async () => {
    const database = createTemplateRunDatabase({ credits: STARTING_CREDITS });
    database.run.is_test = true;

    const run = await pass(database);

    expect(await shownImageSteps(database)).toEqual([
      ['failed', 'Z-Image prompts support up to 1,000 characters.', 'provider_rejected', false],
      ['failed', 'Z-Image prompts support up to 1,000 characters.', 'provider_rejected', false],
    ]);
    expect(run.status).toBe('needs_attention');
    expect(database.starts()).toEqual([]);
  });

  it('offers no retry: it would send the same prompt and the same files', async () => {
    const database = createTemplateRunDatabase({ credits: STARTING_CREDITS });
    await pass(database);

    const [step] = database.imageSteps();
    await expect(retryTemplateRunStep({
      adminClient: database.client,
      runId: TEMPLATE_RUN_ID,
      stepId: String(step.id),
      userId: TEMPLATE_RUN_USER_ID,
    })).rejects.toMatchObject({ status: 409, code: 'STEP_NOT_RETRYABLE' });
  });
});
