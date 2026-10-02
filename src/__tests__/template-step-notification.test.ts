import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  withMobileNotificationHistory,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { createStoredRows } from '@/__tests__/fixtures/stored-rows';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { processGenerationCompletionJobs } from '@/lib/generation-completion-jobs';
import { processGenerationOutputImportJobs } from '@/lib/generation-output-import-jobs-processor';
import { markRefundedGenerationStart } from '@/lib/generation-public-failure';
import { syncGenerationStatusByPredictionId, syncGenerationStatuses } from '@/lib/generation-status-sync';
import type { CompiledTemplateGraph } from '@/lib/media-template-types';
import { buildMobileNotificationDeepLink, notifyGenerationStatus } from '@/lib/mobile-notifications';
import { listOwnerGenerationsForRoute } from '@/lib/owner-generations-route-service';
import { notifyRunStepStartFailure } from '@/lib/run-step-start-failure-notification';
import { reapStalledGenerations } from '@/lib/stalled-generation-reaper';
import { getTemplateStepDefinitions } from '@/lib/template-graph-compiler';
import {
  createCanvasEdge,
  createTemplateReadyStarterGraph,
  createTemplateVersionSnapshotGraph,
  isApprovalGateNode,
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
  type WorkflowHandleType,
} from '@/lib/workflow-canvas';

// The provider key is read once, when the generation modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
});

type Row = Record<string, unknown>;

const OWNER = 'user-1';
const RUN = 'run-1';
const NOW_MS = Date.parse('2026-10-02T10:00:00.000Z');

/**
 * A run of the template the product itself starts people from: two images,
 * each followed by a review, and the video they feed. Without the reviews the
 * images go straight into the video and nobody is asked anything.
 */
function starterRun({ reviews = true }: { reviews?: boolean } = {}) {
  const authored = createTemplateReadyStarterGraph();
  const graph = reviews ? authored : withoutReviews(authored);
  const output = graph.nodes.find((node) => node.type === 'video-generate')!;
  const snapshot = createTemplateVersionSnapshotGraph(graph, output.id);
  const steps = getTemplateStepDefinitions({ graph: snapshot, nodeCosts: {} } as unknown as CompiledTemplateGraph)
    .map((definition, index) => ({
      id: `step-${index + 1}`,
      run_id: RUN,
      node_id: definition.nodeId,
      attempt: 0,
      kind: definition.kind,
      media_kind: definition.mediaKind,
      label: definition.label,
      status: 'queued',
    }));

  return {
    run: {
      id: RUN,
      user_id: OWNER,
      template_id: 'template-1',
      status: 'processing',
      is_test: false,
      output_node_id: output.id,
      graph_snapshot: { graph: snapshot, outputNodeId: output.id },
      result_generation_id: null,
    },
    steps,
    step(label: string) {
      const found = steps.find((candidate) => candidate.label === label);
      if (!found) throw new Error(`The run has no step called ${label}`);
      return found;
    },
  };
}

/** The same template with every review taken out and its two sides joined. */
function withoutReviews(graph: WorkflowCanvasGraph): WorkflowCanvasGraph {
  const reviews = new Set(graph.nodes.filter(isApprovalGateNode).map((node) => node.id));
  const edges = graph.edges.flatMap((edge) => {
    if (reviews.has(edge.target)) return [];
    if (!reviews.has(edge.source)) return [edge];
    const reviewed = graph.edges.find((candidate) => candidate.target === edge.source)!;
    return [createCanvasEdge(reviewed.source, 'image', edge.target, edge.targetHandle as WorkflowHandleType)];
  });
  return normalizeWorkflowGraph({ ...graph, nodes: graph.nodes.filter((node) => !reviews.has(node.id)), edges });
}

/** One row of `generations`, with every column the jobs and the library route read. */
function storedGeneration(overrides: Row = {}): Row {
  return {
    id: 'gen-1',
    user_id: OWNER,
    prediction_id: 'task-1',
    status: 'processing',
    output_url: null,
    model: 'nano-banana-2',
    category: 'image',
    workflow_settings: {},
    created_at: '2026-10-02T09:00:00.000Z',
    completed_at: null,
    archived_at: null,
    submission_unknown_at: null,
    template_run_id: null,
    template_run_step_id: null,
    studio_visible: true,
    ...overrides,
  };
}

/** The generation `start_template_generation` writes for a step: linked to its run, and kept out of the library. */
function stepGeneration(run: ReturnType<typeof starterRun>, label: string, overrides: Row = {}): Row {
  const step = run.step(label);
  return storedGeneration({
    category: step.media_kind,
    model: step.media_kind === 'video' ? 'kling-3.0/video' : 'nano-banana-2',
    template_run_id: RUN,
    template_run_step_id: step.id,
    studio_visible: false,
    ...overrides,
  });
}

/** A finished render whose file is already stored: its import ticket goes straight to the announcement. */
function finished(overrides: Row = {}): Row {
  return { status: 'succeeded', output_url: `generated_images/${OWNER}/generated_task-1.png`, completed_at: '2026-10-02T09:01:00.000Z', ...overrides };
}

/**
 * Everything the jobs, the notifier and the library route read, in one place,
 * with the database calls the jobs make. The jobs settle through the real
 * settlement code; only the stored procedure behind it is stood in for.
 */
function stored(generation: Row, run: { run: Row; steps: Row[] } | null = starterRun()) {
  const generations = [generation];
  const importTickets = [{
    id: 'import-1',
    generation_id: generation.id,
    prediction_id: generation.prediction_id,
    output_urls: ['https://provider.invalid/output.png'],
    provider_completed_at: '2026-10-02T09:01:00.000Z',
    status: 'processing',
    attempt_count: 1,
  }];
  // A completion job on its last attempt: one more "still rendering" and it is given up on.
  const completionJobs = [{
    id: 'completion-1',
    prediction_id: generation.prediction_id,
    payload: {},
    status: 'processing',
    attempt_count: 5,
  }];
  const fail = (row: Row | undefined) => {
    if (!row) return { status: 'missing' };
    row.status = 'failed';
    return { status: 'failed', generation_id: row.id, refunded: true };
  };

  const rows = createStoredRows({
    generations,
    template_runs: run ? [run.run] : [],
    template_run_steps: run ? run.steps : [],
    templates: [{ id: 'template-1', name: 'Rider transformation' }],
    profiles: [{ id: OWNER, merged_into_user_id: null }],
  }, {
    claim_generation_output_import_jobs: () => importTickets.splice(0, 1),
    finish_generation_output_import_job: () => 'succeeded',
    claim_generation_completion_jobs: () => completionJobs.splice(0, 1),
    finish_generation_completion_job: () => 'failed',
    settle_generation_failed: (args) => fail(generations.find((row) => row.prediction_id === args.p_prediction_id)),
    mark_generation_submission_unknown: () => ({ status: 'held' }),
    settle_generation_start_failed: (args) => fail(generations.find((row) => row.id === args.p_generation_id)),
    settle_template_generation_start_failed: (args) => fail(generations.find((row) => row.id === args.p_generation_id)),
  });
  const history = createMobileNotificationHistory();

  return { ...rows, history, client: withMobileNotificationHistory(rows.client, history) };
}

type Stored = ReturnType<typeof stored>;

/**
 * What a tap on the notification reaches, asked the way the phone asks.
 *
 * A viewer link is looked up through the owner library route, which is the
 * request the phone makes for a creation outside the window it has loaded.
 * The phone asks for the summary; the status form used here goes through the
 * same two filters and stops before the media is resolved. A run link is read
 * the way the run screen reads it: the run, owned by the reader.
 */
async function reaches(link: unknown, world: Stored): Promise<string> {
  const url = new URL(String(link), 'https://app.invalid');

  if (url.pathname === '/viewer' && url.searchParams.get('source') === 'studio-creations') {
    const id = url.searchParams.get('initialId') ?? '';
    const library = await listOwnerGenerationsForRoute({
      userId: OWNER,
      supabase: world.client,
      getAdminSupabase: () => world.client,
      searchParams: new URLSearchParams({ detail: 'status', includeArchived: 'true', id, limit: '1' }),
    });
    return library.generations.some((generation) => generation.id === id) ? `creation ${id}` : 'nothing';
  }

  const run = /^\/template-runs\/([^/]+)$/.exec(url.pathname);
  if (run) {
    const { data } = await world.client
      .from('template_runs')
      .select('id')
      .eq('id', decodeURIComponent(run[1]))
      .eq('user_id', OWNER)
      .maybeSingle();
    return data ? `run ${(data as { id: string }).id}` : 'nothing';
  }

  return 'nothing';
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

const importOutput = (world: Stored) => processGenerationOutputImportJobs({ client: world.client, lockedBy: 'import-worker' });

/** The error a start service rethrows once its settlement has failed and refunded the generation. */
function refusedAtStart(generationId: string) {
  const error = new Error('The provider refused the request.');
  markRefundedGenerationStart(error, generationId);
  return error;
}

/**
 * Every way a template step comes to be announced: [what happened, the step's
 * generation as that job finds it, the job, how many times the notifier has to
 * look the run up for itself].
 *
 * A job that reads the generation reads its run with it and hands it over. Only
 * a caller that never read the column leaves the lookup to the notifier.
 */
const ANNOUNCING_JOBS: Array<[
  string,
  (run: ReturnType<typeof starterRun>) => Row,
  (world: Stored) => Promise<unknown>,
  number,
]> = [
  [
    'its file is imported',
    (run) => stepGeneration(run, 'Opening image', finished()),
    importOutput,
    0,
  ],
  [
    'the provider reports the failure in a callback',
    (run) => stepGeneration(run, 'Final image'),
    (world) => syncGenerationStatusByPredictionId({
      supabase: world.client,
      creditSupabase: world.client,
      predictionId: 'task-1',
      providerPayload: { data: { taskId: 'task-1', state: 'fail', failMsg: 'provider failure' } },
    }),
    0,
  ],
  [
    'the run worker asks the provider and finds the failure',
    (run) => stepGeneration(run, 'Final image'),
    (world) => {
      answerProviderStatusChecksWith({ taskId: 'task-1', state: 'fail', failMsg: 'provider failure' });
      return syncGenerationStatuses({ supabase: world.client, creditSupabase: world.client, generationIds: ['gen-1'] });
    },
    0,
  ],
  [
    'the completion job gives up on it',
    (run) => stepGeneration(run, 'Final image'),
    (world) => {
      answerProviderStatusChecksWith({ taskId: 'task-1', state: 'generating' });
      return processGenerationCompletionJobs({
        supabase: world.client,
        creditSupabase: world.client,
        lockedBy: 'completion-worker',
        limit: 1,
      });
    },
    0,
  ],
  [
    'the reaper releases a start that never reached the provider',
    (run) => stepGeneration(run, 'Final image', { status: 'pending', prediction_id: null }),
    (world) => reapStalledGenerations({ supabase: world.client, creditSupabase: world.client, nowMs: NOW_MS }),
    0,
  ],
  [
    'the run worker fails a step whose start was refused',
    (run) => stepGeneration(run, 'Final image', { status: 'failed', prediction_id: null }),
    (world) => notifyRunStepStartFailure({ client: world.client, error: refusedAtStart('gen-1'), userId: OWNER }),
    0,
  ],
  [
    // No job is left that does this. The next one written, or a row read
    // without the column, still has to lead to the run.
    'a caller that knows the creation and nothing of its run announces the failure',
    (run) => stepGeneration(run, 'Final image', { status: 'failed' }),
    (world) => notifyGenerationStatus(
      world.client,
      { id: 'gen-1', user_id: OWNER, category: 'image', model: 'nano-banana-2' },
      'failed',
    ),
    1,
  ],
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Nothing here may reach the network.');
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('where a template step notification takes its reader', () => {
  it.each(ANNOUNCING_JOBS)('opens the run when %s', async (_happened, generationFor, job, ownLookups) => {
    const run = starterRun();
    const world = stored(generationFor(run), run);

    await job(world);
    const lookedUpByTheNotifier = world.reads.filter((read) => (
      read.table === 'generations' && read.columns.join() === 'template_run_id'
    ));

    expect(world.history.sent).toHaveLength(1);
    // The library hides a step's creation, so a link to it reaches nothing.
    expect(await reaches(world.history.sent[0].deep_link, world)).toBe(`run ${RUN}`);
    expect(world.history.sent[0].deep_link).toBe(`/template-runs/${RUN}`);
    expect(lookedUpByTheNotifier).toHaveLength(ownLookups);
  });

  it('keeps the dedupe key and the object of the notification on the creation', async () => {
    const run = starterRun();
    const world = stored(stepGeneration(run, 'Opening image', finished()), run);

    await importOutput(world);

    // One notification per creation and outcome, however many jobs report it.
    expect(world.history.sent[0]).toMatchObject({
      user_id: OWNER,
      type: 'generation_succeeded',
      category: 'generation',
      object_type: 'generation',
      object_id: 'gen-1',
      dedupe_key: 'generation:gen-1:succeeded',
    });
  });

  it('still opens an ordinary creation in the viewer', async () => {
    const world = stored(storedGeneration(finished()), null);

    await importOutput(world);

    expect(world.history.sent).toHaveLength(1);
    expect(world.history.sent[0].deep_link).toBe('/viewer?source=studio-creations&initialId=gen-1');
    expect(await reaches(world.history.sent[0].deep_link, world)).toBe('creation gen-1');
  });

  it('builds the run link the phone routes on', () => {
    expect(buildMobileNotificationDeepLink({ kind: 'templateRun', runId: RUN })).toBe(`/template-runs/${RUN}`);
    expect(buildMobileNotificationDeepLink({ kind: 'templateRun', runId: 'run/1 ?' })).toBe('/template-runs/run%2F1%20%3F');
  });
});

describe('which finished template steps are announced', () => {
  it('announces a step whose result waits for a review', async () => {
    const run = starterRun();
    const world = stored(stepGeneration(run, 'Opening image', finished()), run);

    await expect(importOutput(world)).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, exhausted: 0 });

    expect(world.history.sent).toEqual([expect.objectContaining({
      type: 'generation_succeeded',
      title: 'Your image is ready to review',
      body: 'Approve it to keep your template run going.',
      deep_link: `/template-runs/${RUN}`,
    })]);
  });

  it('announces the step that is the result', async () => {
    const run = starterRun();
    const world = stored(stepGeneration(run, 'Final video', finished({
      output_url: `generated_videos/${OWNER}/generated_task-1.mp4`,
    })), run);

    await expect(importOutput(world)).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, exhausted: 0 });

    expect(world.history.sent).toEqual([expect.objectContaining({
      type: 'generation_succeeded',
      title: 'Your video is ready',
      body: 'Your template run is finished. Open it to see the result.',
      deep_link: `/template-runs/${RUN}`,
    })]);
  });

  it.each(['Opening image', 'Final image'])(
    'says nothing for %s when the run carries on from it by itself',
    async (label) => {
      // No review after either image: each goes straight into the video.
      const run = starterRun({ reviews: false });
      const world = stored(stepGeneration(run, label, finished()), run);

      // The file is still imported and its ticket still closed, before the job asks for the next one.
      await expect(importOutput(world)).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, exhausted: 0 });
      expect(world.called).toEqual([
        'claim_generation_output_import_jobs',
        'finish_generation_output_import_job',
        'claim_generation_output_import_jobs',
      ]);

      expect(world.history.started).toEqual([]);
      expect(world.history.sent).toEqual([]);
    },
  );

  it('still announces the result of a run with no reviews', async () => {
    const run = starterRun({ reviews: false });
    const world = stored(stepGeneration(run, 'Final video', finished()), run);

    await importOutput(world);

    expect(world.history.sent).toEqual([expect.objectContaining({ title: 'Your video is ready' })]);
  });

  type Run = ReturnType<typeof starterRun>;
  type Damage = { run?: { run: Row; steps: Row[] }; generation?: Row };

  // [what is wrong, the reason it logs, the damage done to the run or to the generation's link to it]
  it.each<[string, string, (run: Run) => Damage]>([
    ['its run is gone', 'The run is gone.', (run) => ({
      run: { ...run, run: { ...run.run, id: 'another-run' } },
    })],
    ['its step is gone', 'The step is gone.', (run) => ({
      run: { ...run, steps: run.steps.filter((step) => step.label !== 'Opening image') },
    })],
    ['its run has no graph to read', 'The run stored no graph that holds this step.', (run) => ({
      run: { ...run, run: { ...run.run, graph_snapshot: { graph: null, outputNodeId: run.run.output_node_id } } },
    })],
    ['it names a run and no step', 'The generation names a run and no step.', () => ({
      generation: { template_run_step_id: null },
    })],
  ])('announces a step it cannot place when %s, rather than leave a run waiting unannounced', async (_case, reason, damage) => {
    const run = starterRun();
    const damaged = damage(run);
    const world = stored(stepGeneration(run, 'Opening image', finished(damaged.generation)), damaged.run ?? run);

    await withCapturedLog(async (logged) => {
      await expect(importOutput(world)).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, exhausted: 0 });

      // The log says which step and why, so the run can be found.
      expect(logged).toEqual([expect.objectContaining({
        level: 'error',
        msg: 'template_step_announcement_unplaced',
        generationId: 'gen-1',
        runId: RUN,
        errorMessage: reason,
      })]);
    });

    // It cannot say whether a review is waiting, so it says neither.
    expect(world.history.sent).toEqual([expect.objectContaining({
      title: 'Your image is ready',
      body: 'Open your template run to see it.',
      deep_link: `/template-runs/${RUN}`,
    })]);
  });

  it('announces every failed step, whatever follows it', async () => {
    const run = starterRun({ reviews: false });
    const world = stored(stepGeneration(run, 'Opening image'), run);

    await syncGenerationStatusByPredictionId({
      supabase: world.client,
      creditSupabase: world.client,
      predictionId: 'task-1',
      providerPayload: { data: { taskId: 'task-1', state: 'fail', failMsg: 'provider failure' } },
    });

    expect(world.history.sent).toEqual([expect.objectContaining({
      type: 'generation_failed',
      title: 'Your image failed',
      body: 'Open your template run to retry this step.',
      deep_link: `/template-runs/${RUN}`,
    })]);
  });
});

describe('what a template step notification says', () => {
  /** The notification the real notifier writes for one generation it is handed. */
  async function written(
    generation: { category: string; template_run_id: string | null },
    ...rest: [status: 'succeeded' | 'failed', step?: 'review' | 'result']
  ) {
    const history: MobileNotificationHistory = createMobileNotificationHistory();
    const noOtherTables = {
      from(table: string) {
        throw new Error(`Unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient;

    await notifyGenerationStatus(
      withMobileNotificationHistory(noOtherTables, history),
      { id: 'gen-1', user_id: OWNER, model: null, ...generation },
      ...rest,
    );

    expect(history.sent).toHaveLength(1);
    return history.sent[0];
  }

  it.each([
    ['image', 'review', 'Your image is ready to review', 'Approve it to keep your template run going.'],
    ['video', 'review', 'Your video is ready to review', 'Approve it to keep your template run going.'],
    ['image', 'result', 'Your image is ready', 'Your template run is finished. Open it to see the result.'],
    ['video', 'result', 'Your video is ready', 'Your template run is finished. Open it to see the result.'],
    ['image', undefined, 'Your image is ready', 'Open your template run to see it.'],
  ] as const)('tells the person their %s step is ready (%s)', async (category, step, title, body) => {
    expect(await written({ category, template_run_id: RUN }, 'succeeded', step)).toEqual({
      user_id: OWNER,
      actor_user_id: null,
      type: 'generation_succeeded',
      category: 'generation',
      title,
      body,
      deep_link: `/template-runs/${RUN}`,
      object_type: 'generation',
      object_id: 'gen-1',
      dedupe_key: 'generation:gen-1:succeeded',
      aggregation_key: null,
    });
  });

  it.each(['image', 'video'] as const)('tells the person their %s step failed, and where to retry it', async (category) => {
    expect(await written({ category, template_run_id: RUN }, 'failed')).toEqual({
      user_id: OWNER,
      actor_user_id: null,
      type: 'generation_failed',
      category: 'generation',
      title: `Your ${category} failed`,
      // The recipe is the template's: its runner has no prompt to adjust.
      body: 'Open your template run to retry this step.',
      deep_link: `/template-runs/${RUN}`,
      object_type: 'generation',
      object_id: 'gen-1',
      dedupe_key: 'generation:gen-1:failed',
      aggregation_key: null,
    });
  });

  it('leaves an ordinary creation worded as it was, whatever it is told about steps', async () => {
    expect(await written({ category: 'image', template_run_id: null }, 'succeeded', 'review')).toMatchObject({
      title: 'Your image is ready',
      body: 'Open it in your mobile history.',
      deep_link: '/viewer?source=studio-creations&initialId=gen-1',
    });
    expect(await written({ category: 'video', template_run_id: null }, 'failed')).toMatchObject({
      title: 'Your video failed',
      body: 'Open Magicbooklet to try again or adjust the prompt.',
      deep_link: '/viewer?source=studio-creations&initialId=gen-1',
    });
  });
});

describe('a caller that hands the notifier no run', () => {
  const unaware = { id: 'gen-1', user_id: OWNER, category: 'image', model: 'nano-banana-2' };

  it('has the run looked up, once, before anything is written', async () => {
    const run = starterRun();
    const world = stored(stepGeneration(run, 'Final image', { status: 'failed' }), run);

    await notifyGenerationStatus(world.client, unaware, 'failed');

    expect(world.reads).toEqual([{ table: 'generations', columns: ['template_run_id'] }]);
    expect(world.history.sent[0].deep_link).toBe(`/template-runs/${RUN}`);
  });

  it('finds an ordinary creation to be one, and links to it as before', async () => {
    const world = stored(storedGeneration({ status: 'failed' }), null);

    await notifyGenerationStatus(world.client, unaware, 'failed');

    expect(world.history.sent[0]).toMatchObject({
      body: 'Open Magicbooklet to try again or adjust the prompt.',
      deep_link: '/viewer?source=studio-creations&initialId=gen-1',
    });
  });

  it.each([
    ['a step', RUN],
    ['an ordinary creation', null],
  ])('reads nothing when the caller says it is %s', async (_case, templateRunId) => {
    const run = starterRun();
    const world = stored(stepGeneration(run, 'Final image', { status: 'failed' }), run);

    await notifyGenerationStatus(world.client, { ...unaware, template_run_id: templateRunId }, 'failed');

    expect(world.reads).toEqual([]);
    expect(world.history.sent).toHaveLength(1);
  });

  it.each<[string, () => unknown]>([
    ['the read throws', () => {
      throw new Error('generations unavailable');
    }],
    ['the read is refused', () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'permission denied' } }) }),
      }),
    })],
  ])('still sends the notification when %s', async (_case, generations) => {
    const history = createMobileNotificationHistory();
    const unreadable = withMobileNotificationHistory({ from: generations } as unknown as SupabaseClient, history);

    await withCapturedLog(async (logged) => {
      await expect(notifyGenerationStatus(unreadable, unaware, 'failed')).resolves.not.toBeNull();

      expect(logged.map((record) => record.msg)).toEqual(['generation_notification_run_unread']);
    });

    // Nearly every creation is an ordinary one, and its link is this one.
    expect(history.sent).toEqual([expect.objectContaining({
      title: 'Your image failed',
      deep_link: '/viewer?source=studio-creations&initialId=gen-1',
    })]);
  });

  it('logs and answers, never rejects, with nothing to read and nowhere to write', async () => {
    // It is sent behind a response and from jobs: a rejection would reach nobody.
    const unavailable = {
      from() {
        throw new Error('database unavailable');
      },
    } as unknown as SupabaseClient;

    await withCapturedLog(async (logged) => {
      await expect(notifyGenerationStatus(unavailable, unaware, 'failed')).resolves.toBeNull();

      expect(logged.map((record) => record.msg)).toEqual([
        'generation_notification_run_unread',
        'failed_to_create_mobile_notification',
      ]);
    });
  });
});
