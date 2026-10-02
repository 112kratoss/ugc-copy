import fs from 'node:fs';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
  withUniqueDedupeKeys,
} from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  syncGenerationStatusByPredictionId,
  syncGenerationStatuses,
} from '@/lib/generation-status-sync';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';

// The provider key is read once, when the generation modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
});

type GenerationRow = {
  id: string;
  user_id: string;
  prediction_id: string;
  status: string;
  output_url: string | null;
  model: string;
  category: string | null;
  workflow_settings: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
  template_run_id: string | null;
};

type Settlement = 'failed' | 'already_succeeded' | 'unavailable';

const FAILED_KEY = 'generation:gen-1:failed';

function generation(overrides: Partial<GenerationRow> = {}): GenerationRow {
  return {
    id: 'gen-1',
    user_id: 'user-1',
    prediction_id: 'task-1',
    status: 'processing',
    output_url: null,
    model: 'nano-banana-pro',
    category: 'image',
    workflow_settings: null,
    created_at: '2026-10-01T10:00:00.000Z',
    completed_at: null,
    template_run_id: null,
    ...overrides,
  };
}

function veoGeneration(overrides: Partial<GenerationRow> = {}) {
  return generation({ model: 'veo3_fast', category: 'video', ...overrides });
}

/**
 * The generations table and the failure settlement, as the status sync uses
 * them. `settlement` is what the database answers, whatever the row said when
 * it was read: `already_succeeded` is a render whose output landed in between.
 */
function createGenerationsClient(rows: GenerationRow[], settlement: Settlement = 'failed') {
  const settled: string[] = [];
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== 'settle_generation_failed') throw new Error(`Unexpected RPC: ${fn}`);
      settled.push(String(args.p_prediction_id));

      if (settlement === 'unavailable') {
        return { data: null, error: { message: 'settlement unavailable' } };
      }

      const row = rows.find((candidate) => candidate.prediction_id === args.p_prediction_id);
      if (!row) return { data: { status: 'missing' }, error: null };

      if (settlement === 'already_succeeded') {
        row.status = 'succeeded';
        return { data: { status: 'already_succeeded', generation_id: row.id }, error: null };
      }

      row.status = 'failed';
      return { data: { status: 'failed', generation_id: row.id, refunded: true }, error: null };
    },
    from(table: string) {
      if (table !== 'generations') throw new Error(`Unexpected table: ${table}`);
      return {
        select() {
          return {
            async in(column: keyof GenerationRow, values: unknown[]) {
              return {
                data: rows.filter((row) => values.includes(row[column])).map((row) => ({ ...row })),
                error: null,
              };
            },
            eq(column: keyof GenerationRow, value: unknown) {
              return {
                async single() {
                  const row = rows.find((candidate) => candidate[column] === value);
                  return row
                    ? { data: { ...row }, error: null }
                    : { data: null, error: { code: 'PGRST116', message: 'No rows found' } };
                },
              };
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, settled };
}

/** What the provider says about a task that failed, in each of its two dialects. */
function failedTask(row: GenerationRow, veo: boolean) {
  return veo
    ? { taskId: row.prediction_id, successFlag: 3, errorMessage: 'provider failure' }
    : { taskId: row.prediction_id, state: 'fail', failMsg: 'provider failure' };
}

function answerProviderStatusChecksWith(task: Record<string, unknown>) {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ code: 200, data: task }),
  } as Response);
}

/** Runs `run` with the backend log captured, so a logged failure is asserted on and not printed. */
async function withCapturedLog<T>(run: (logged: BackendLogRecord[]) => Promise<T>) {
  const logged: BackendLogRecord[] = [];
  const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });
  try {
    return await run(logged);
  } finally {
    restoreLogSink();
  }
}

/** [who reported it, whether it speaks Veo's dialect, what the creator is told] */
const PROVIDER_DIALECTS: Array<[string, boolean, string]> = [
  ['the task API', false, 'Your image failed'],
  ['Veo', true, 'Your video failed'],
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('The provider must not be asked for a status here.');
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a render that fails away from a status poll', () => {
  it.each(PROVIDER_DIALECTS)(
    'tells the creator when a callback from %s reports the failure',
    async (_provider, veo, title) => {
      const row = veo ? veoGeneration() : generation();
      const history = createMobileNotificationHistory();
      const client = withMobileNotificationHistory(createGenerationsClient([row]).client, history);

      await expect(syncGenerationStatusByPredictionId({
        supabase: client,
        creditSupabase: client,
        predictionId: 'task-1',
        providerPayload: { data: failedTask(row, veo) },
      })).resolves.toMatchObject({ found: true, status: 'failed' });

      expect(fetch).not.toHaveBeenCalled();
      expect(history.sent).toEqual([expect.objectContaining({
        user_id: 'user-1',
        type: 'generation_failed',
        category: 'generation',
        title,
        object_type: 'generation',
        object_id: 'gen-1',
        dedupe_key: FAILED_KEY,
      })]);
    },
  );

  it.each(PROVIDER_DIALECTS)(
    'tells the creator when the completion job asks %s and finds the failure',
    async (_provider, veo, title) => {
      const row = veo ? veoGeneration() : generation();
      answerProviderStatusChecksWith(failedTask(row, veo));
      const history = createMobileNotificationHistory();
      const client = withMobileNotificationHistory(createGenerationsClient([row]).client, history);

      await expect(syncGenerationStatusByPredictionId({
        supabase: client,
        creditSupabase: client,
        predictionId: 'task-1',
      })).resolves.toMatchObject({ found: true, status: 'failed' });

      expect(history.sent).toEqual([expect.objectContaining({
        user_id: 'user-1',
        title,
        dedupe_key: FAILED_KEY,
      })]);
    },
  );

  it.each(PROVIDER_DIALECTS)(
    'tells the creator when a run worker asks %s and finds the failure',
    async (_provider, veo, title) => {
      const row = veo ? veoGeneration() : generation();
      answerProviderStatusChecksWith(failedTask(row, veo));
      const history = createMobileNotificationHistory();
      const client = withMobileNotificationHistory(createGenerationsClient([row]).client, history);

      await syncGenerationStatuses({
        supabase: client,
        creditSupabase: client,
        generationIds: ['gen-1'],
      });

      expect(row.status).toBe('failed');
      expect(history.sent).toEqual([expect.objectContaining({
        user_id: 'user-1',
        title,
        dedupe_key: FAILED_KEY,
      })]);
    },
  );

  it.each(PROVIDER_DIALECTS)(
    'settles a failure from %s and stays quiet for a caller someone is waiting on',
    async (_provider, veo) => {
      const row = veo ? veoGeneration() : generation();
      answerProviderStatusChecksWith(failedTask(row, veo));
      const history = createMobileNotificationHistory();
      const { client, settled } = createGenerationsClient([row]);
      const notified = withMobileNotificationHistory(client, history);

      await syncGenerationStatuses({
        supabase: notified,
        creditSupabase: notified,
        generationIds: ['gen-1'],
        notifyFailures: false,
      });

      expect(settled).toEqual(['task-1']);
      expect(row.status).toBe('failed');
      expect(history.started).toEqual([]);
    },
  );

  it('has sent the notification by the time the job is answered', async () => {
    const row = generation();
    const history = createMobileNotificationHistory();
    history.hold();
    const client = withMobileNotificationHistory(createGenerationsClient([row]).client, history);

    const sync = syncGenerationStatusByPredictionId({
      supabase: client,
      creditSupabase: client,
      predictionId: 'task-1',
      providerPayload: { data: failedTask(row, false) },
    });

    // A job has no response to send it behind. Let go of unfinished, the send
    // would be cut off when the function that ran the job is frozen.
    expect(await hasAnswered(sync)).toBe(false);
    expect(history.started).toEqual([FAILED_KEY]);

    history.release();
    await expect(sync).resolves.toMatchObject({ status: 'failed' });
    expect(history.sent).toHaveLength(1);
  });

  it('sends nothing when the render had succeeded by the time the failure was settled', async () => {
    const row = generation();
    const history = createMobileNotificationHistory();
    const { client, settled } = createGenerationsClient([row], 'already_succeeded');
    const notified = withMobileNotificationHistory(client, history);

    await expect(syncGenerationStatusByPredictionId({
      supabase: notified,
      creditSupabase: notified,
      predictionId: 'task-1',
      providerPayload: { data: failedTask(row, false) },
    })).resolves.toMatchObject({ status: 'succeeded' });

    expect(settled).toEqual(['task-1']);
    expect(history.started).toEqual([]);
  });

  it('sends nothing when the failure could not be settled', async () => {
    const row = generation();
    const history = createMobileNotificationHistory();
    const { client } = createGenerationsClient([row], 'unavailable');
    const notified = withMobileNotificationHistory(client, history);

    await expect(syncGenerationStatusByPredictionId({
      supabase: notified,
      creditSupabase: notified,
      predictionId: 'task-1',
      providerPayload: { data: failedTask(row, false) },
    })).rejects.toThrow('settlement unavailable');

    expect(history.started).toEqual([]);
  });

  it('sends nothing for a render that had already failed', async () => {
    // A redelivered callback, or the cron replaying a job: the row is read as
    // failed and nothing is settled again.
    const row = generation({ status: 'failed', completed_at: '2026-10-01T10:01:00.000Z' });
    const history = createMobileNotificationHistory();
    const { client, settled } = createGenerationsClient([row]);
    const notified = withMobileNotificationHistory(client, history);

    await expect(syncGenerationStatusByPredictionId({
      supabase: notified,
      creditSupabase: notified,
      predictionId: 'task-1',
      providerPayload: { data: failedTask(row, false) },
    })).resolves.toMatchObject({ status: 'failed' });

    expect(settled).toEqual([]);
    expect(history.started).toEqual([]);
  });

  it('keeps the settlement when the notification cannot be written', async () => {
    const row = generation();
    // No notification tables behind this client: every notifier call throws.
    const { client, settled } = createGenerationsClient([row]);

    await withCapturedLog(async (logged) => {
      await expect(syncGenerationStatusByPredictionId({
        supabase: client,
        creditSupabase: client,
        predictionId: 'task-1',
        providerPayload: { data: failedTask(row, false) },
      })).resolves.toMatchObject({ found: true, status: 'failed' });

      expect(logged.map((record) => record.msg)).toEqual(['failed_to_create_mobile_notification']);
    });

    expect(settled).toEqual(['task-1']);
    expect(row.status).toBe('failed');
  });
});

describe('one failure, reported by the job and by a status poll', () => {
  it('sends one notification when the poll reports it afterwards', async () => {
    const row = generation();
    const history = createMobileNotificationHistory();
    const client = withMobileNotificationHistory(
      createGenerationsClient([row]).client,
      withUniqueDedupeKeys(history),
    );

    await syncGenerationStatusByPredictionId({
      supabase: client,
      creditSupabase: client,
      predictionId: 'task-1',
      providerPayload: { data: failedTask(row, false) },
    });
    // What a status poll sends once it has settled the same failure itself.
    await notifyGenerationStatus(client, row, 'failed');

    expect(history.started).toEqual([FAILED_KEY, FAILED_KEY]);
    expect(history.sent).toHaveLength(1);
  });

  it('sends one notification when both report it at the same moment', async () => {
    const row = generation();
    const history = createMobileNotificationHistory();
    history.hold();
    const client = withMobileNotificationHistory(
      createGenerationsClient([row]).client,
      withUniqueDedupeKeys(history),
    );

    await withCapturedLog(async (logged) => {
      const job = syncGenerationStatusByPredictionId({
        supabase: client,
        creditSupabase: client,
        predictionId: 'task-1',
        providerPayload: { data: failedTask(row, false) },
      });
      expect(await hasAnswered(job)).toBe(false);
      const poll = notifyGenerationStatus(client, row, 'failed');
      expect(await hasAnswered(poll)).toBe(false);

      // Both have looked and found nothing. The index decides between them.
      expect(history.started).toEqual([FAILED_KEY, FAILED_KEY]);
      history.release();
      await Promise.all([job, poll]);

      expect(history.sent).toHaveLength(1);
      expect(logged.map((record) => record.msg)).toEqual(['failed_to_create_mobile_notification']);
    });
  });

  it('rests on a unique index that no migration has dropped', () => {
    const migrations = path.resolve('supabase/migrations');
    const created = fs.readFileSync(path.join(migrations, '20260519120000_mobile_notifications.sql'), 'utf8');

    expect(created).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS mobile_notifications_user_dedupe_key_idx\s+ON public\.mobile_notifications \(user_id, dedupe_key\)\s+WHERE dedupe_key IS NOT NULL;/,
    );
    for (const file of fs.readdirSync(migrations)) {
      const sql = fs.readFileSync(path.join(migrations, file), 'utf8');
      expect(sql, file).not.toMatch(/DROP INDEX[^;]*mobile_notifications_user_dedupe_key_idx/i);
    }
  });
});

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

/** Every module under `src`, tests aside: its path from the repository root, and its source. */
function sourceModules(): Array<[string, string]> {
  return sourceFiles(path.resolve('src')).map((file) => [
    path.relative(process.cwd(), file).split(path.sep).join('/'),
    fs.readFileSync(file, 'utf8'),
  ]);
}

describe('every module that settles a failed render', () => {
  // The push was first written into the status poll alone. When the provider
  // callback became the first to settle a failure, nothing moved it, and most
  // failed renders told nobody. A module that settles a failure either sends
  // the notification or is named here with the reason it need not.
  const SPOKEN_FOR: Record<string, string> = {
    'src/lib/generation-settlement.ts': 'the settlement itself',
    // The start services mark what they refunded and leave the telling to
    // their caller. A request answers in its response. A run worker has no
    // request to answer, and is held to announcing it by the guard below.
    'src/lib/generation-services.ts':
      'a creation refused at start is answered in the response to its request, or announced by the run worker that started it',
  };
  const SETTLES_A_FAILURE = new RegExp([
    String.raw`(?<!function )settleGenerationFailed\(`,
    String.raw`'settle_generation_failed'`,
    String.raw`'settle_(?:template_)?generation_start_failed'`,
  ].join('|'));

  it('also tells the creator, or says why it does not have to', () => {
    const silent: string[] = [];
    const settling: string[] = [];

    for (const [name, source] of sourceModules()) {
      if (!SETTLES_A_FAILURE.test(source)) continue;

      settling.push(name);
      if (!source.includes('notifyGenerationStatus(') && !SPOKEN_FOR[name]) silent.push(name);
    }

    expect(silent).toEqual([]);
    // The scan is looking at the code it thinks it is.
    expect(settling).toEqual(expect.arrayContaining([
      ...Object.keys(SPOKEN_FOR),
      'src/lib/generation-completion-jobs.ts',
      'src/lib/generation-status-sync.ts',
      'src/lib/image-generation-status-service.ts',
      'src/lib/stalled-generation-reaper.ts',
    ]));
  });
});

describe('every worker that starts a run step', () => {
  // A step started through the node executor has no request to carry a
  // refusal. A run engine added later inherits the gap unless it announces a
  // refused start as these two do.
  const STARTS_A_STEP = /(?<!function )executeWorkflowRunnableNode\(/;

  it('announces a start that was refused and refunded', () => {
    const silent: string[] = [];
    const starting: string[] = [];

    for (const [name, source] of sourceModules()) {
      if (!STARTS_A_STEP.test(source)) continue;

      starting.push(name);
      if (!source.includes('notifyRunStepStartFailure(')) silent.push(name);
    }

    expect(silent).toEqual([]);
    // The scan is looking at the code it thinks it is.
    expect(starting).toEqual(expect.arrayContaining([
      'src/lib/template-run-service.ts',
      'src/lib/workflow-runner.ts',
    ]));
  });
});
