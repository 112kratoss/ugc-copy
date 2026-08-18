import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CatalogError } from '@/lib/generation-model-catalog';
import { validateAndCompileTemplateGraph } from '@/lib/template-graph-compiler';
import {
  createTemplateReadyStarterGraph,
  normalizeNodeData,
  type ImageGenerateNodeData,
} from '@/lib/workflow-canvas';

const mocks = vi.hoisted(() => ({
  executeWorkflowRunnableNode: vi.fn(),
  enqueueTemplateRunJob: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'job-1'),
  syncGenerationStatuses: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  resolveStoredMediaUrl: vi.fn(async (_client: unknown, value: string) => `signed:${value}`),
}));

vi.mock('@/lib/workflow-runner', () => ({
  executeWorkflowRunnableNode: (...args: unknown[]) => mocks.executeWorkflowRunnableNode(...args),
}));

vi.mock('@/lib/template-run-jobs', () => ({
  enqueueTemplateRunJob: (...args: unknown[]) => mocks.enqueueTemplateRunJob(...args),
}));

vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: (...args: unknown[]) => mocks.syncGenerationStatuses(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => {
    throw new Error('createServiceClient must not be needed by template run sync tests');
  },
  resolveStoredMediaUrl: (...args: unknown[]) => (
    mocks.resolveStoredMediaUrl(...(args as [unknown, string]))
  ),
}));

vi.mock('@/lib/generation-services', () => ({}));

vi.mock('@/lib/backend-logger', () => ({
  logBackendError: vi.fn(),
}));

const PINNED_REVISION = 'rev-pinned-2026-07-11';

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'neq' | 'in'; column: string; value: unknown };
type CapturedWrite = { table: string; payload: Row; filters: Filter[] };

/** Chainable in-memory stand-in for the few PostgREST query shapes the run
 * service issues. Updates mutate the seeded rows so reloads observe them. */
function createFakeSupabase(seed: { runs: Row[]; steps: Row[]; generations: Row[] }) {
  const tables: Record<string, Row[]> = {
    template_runs: seed.runs,
    template_run_steps: seed.steps,
    generations: seed.generations,
  };
  const writes: CapturedWrite[] = [];

  function matches(row: Row, filters: Filter[]) {
    return filters.every((filter) => {
      if (filter.op === 'eq') return row[filter.column] === filter.value;
      if (filter.op === 'neq') return row[filter.column] !== filter.value;
      return Array.isArray(filter.value) && filter.value.includes(row[filter.column]);
    });
  }

  function builder(table: string) {
    const filters: Filter[] = [];
    let payload: Row | null = null;
    let operation: 'select' | 'update' | 'insert' | 'delete' = 'select';
    const run = () => {
      const rows = (tables[table] ?? []).filter((row) => matches(row, filters));
      if (operation === 'update' && payload) {
        writes.push({ table, payload, filters: [...filters] });
        for (const row of rows) Object.assign(row, payload);
      }
      if (operation === 'delete') {
        tables[table] = (tables[table] ?? []).filter((row) => !matches(row, filters));
      }
      return rows;
    };
    const api = {
      select: () => api,
      update: (value: Row) => {
        operation = 'update';
        payload = value;
        return api;
      },
      insert: (value: Row | Row[]) => {
        operation = 'insert';
        (tables[table] ??= []).push(...(Array.isArray(value) ? value : [value]));
        return api;
      },
      delete: () => {
        operation = 'delete';
        return api;
      },
      eq: (column: string, value: unknown) => {
        filters.push({ op: 'eq', column, value });
        return api;
      },
      neq: (column: string, value: unknown) => {
        filters.push({ op: 'neq', column, value });
        return api;
      },
      in: (column: string, value: unknown[]) => {
        filters.push({ op: 'in', column, value });
        return api;
      },
      order: () => api,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => (
        resolve({ data: run(), error: null })
      ),
    };
    return api;
  }

  return {
    writes,
    tables,
    client: {
      from: (table: string) => builder(table),
      rpc: vi.fn(async () => ({ data: true, error: null })),
      storage: {
        from: () => ({
          remove: async () => ({ error: null }),
          download: async () => ({ data: null, error: null }),
        }),
      },
    } as never,
  };
}

function seedTemplateRun() {
  const graph = createTemplateReadyStarterGraph();
  const output = graph.nodes.find((node) => node.type === 'video-generate');
  if (!output) throw new Error('Starter output is missing.');
  const { compiled } = validateAndCompileTemplateGraph({
    graph,
    outputNodeId: output.id,
    canvasRevision: 3,
    catalogRevision: null,
  });
  if (!compiled) throw new Error('Starter graph must compile.');

  const snapshot = {
    ...compiled,
    catalogRevision: PINNED_REVISION,
    templateId: 'template-1',
    templateVersionId: 'version-1',
    templateTitle: 'Pinned template',
    sourceCanvasId: 'canvas-1',
    sourceCanvasRevision: 3,
    demoOutputUrl: null,
  };

  const inputPaths = Object.fromEntries(compiled.inputSlots.map((slot) => [
    slot.key,
    `template_inputs/user-1/run-1/final/${slot.key}/input.png`,
  ]));

  const run: Row = {
    id: 'run-1',
    template_id: 'template-1',
    template_version_id: 'version-1',
    user_id: 'user-1',
    graph_snapshot: snapshot,
    graph_hash: compiled.graphHash,
    input_manifest: compiled.inputSlots,
    input_storage_paths: inputPaths,
    output_node_id: compiled.outputNodeId,
    output_kind: compiled.outputKind,
    status: 'queued',
    estimated_total_credits: compiled.estimatedTotalCredits,
    estimated_remaining_credits: compiled.estimatedTotalCredits,
    credits_used: 0,
    result_url: null,
    result_generation_id: null,
    error_message: null,
    is_test: false,
    source_canvas_revision: 3,
    catalog_revision: PINNED_REVISION,
    completed_at: null,
    inputs_deleted_at: null,
    usage_counted_at: null,
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
  };

  const graphNodes = compiled.graph as { nodes?: Array<{ id: string; type: string; data: { title?: string } }> };
  const steps: Row[] = (graphNodes.nodes ?? [])
    .filter((node) => ['image-generate', 'video-generate', 'approval-gate'].includes(node.type))
    .map((node, index) => ({
      id: `step-${index + 1}`,
      run_id: 'run-1',
      node_id: node.id,
      attempt: 0,
      kind: node.type === 'approval-gate' ? 'approval' : 'generation',
      media_kind: node.type === 'video-generate' ? 'video' : 'image',
      label: node.data.title ?? node.id,
      status: 'queued',
      generation_id: null,
      output_url: null,
      error_message: null,
      can_retry: true,
      estimated_credits: compiled.nodeCosts[node.id] ?? 0,
      input_snapshot: null,
      output_snapshot: null,
      approved_at: null,
      started_at: null,
      finished_at: null,
      created_at: '2026-08-18T00:00:00.000Z',
    }));

  return { snapshot, run, steps };
}

describe('template run catalog pinning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveStoredMediaUrl.mockImplementation(async (_client: unknown, value: string) => `signed:${value}`);
  });

  it('executes template steps with quoting pinned to the snapshot catalog revision', async () => {
    const { run, steps } = seedTemplateRun();
    const db = createFakeSupabase({ runs: [run], steps, generations: [] });
    mocks.executeWorkflowRunnableNode.mockResolvedValue({
      status: 'processing',
      generation_id: 'generation-1',
      input_snapshot: {},
      output_snapshot: {},
      error_message: null,
    });

    const { syncTemplateRun } = await import('@/lib/template-run-service');
    await syncTemplateRun({ adminClient: db.client, runId: 'run-1', userId: 'user-1' });

    expect(mocks.executeWorkflowRunnableNode).toHaveBeenCalled();
    for (const call of mocks.executeWorkflowRunnableNode.mock.calls) {
      expect(call[0]).toMatchObject({
        catalogRevision: PINNED_REVISION,
        quoteAtPinnedRevision: true,
      });
    }
  });

  it('fails the step loudly instead of stranding the run when the pinned catalog is gone', async () => {
    const { run, steps } = seedTemplateRun();
    const db = createFakeSupabase({ runs: [run], steps, generations: [] });
    mocks.executeWorkflowRunnableNode.mockRejectedValue(new CatalogError(
      'The model catalog has changed. Refresh settings before generating.',
      'CATALOG_CHANGED',
      409,
    ));

    const { syncTemplateRun } = await import('@/lib/template-run-service');
    const dto = await syncTemplateRun({ adminClient: db.client, runId: 'run-1', userId: 'user-1' });

    const failedStepWrites = db.writes.filter((write) => (
      write.table === 'template_run_steps' && write.payload.status === 'failed'
    ));
    expect(failedStepWrites.length).toBeGreaterThan(0);
    for (const write of failedStepWrites) {
      expect(write.payload.can_retry).toBe(false);
      expect(write.payload.error_message).toMatch(/republish/i);
      expect(write.payload.finished_at).toBeTruthy();
    }

    expect(dto.status).toBe('needs_attention');
    const failedSteps = dto.steps.filter((step) => step.status === 'failed');
    expect(failedSteps.length).toBeGreaterThan(0);
    for (const step of failedSteps) {
      expect(step.canRetry).toBe(false);
      expect(step.errorMessage).toMatch(/republish/i);
    }
  });

  it('keeps swallowing non-catalog 409 conflicts so concurrent workers stay idempotent', async () => {
    const { run, steps } = seedTemplateRun();
    const db = createFakeSupabase({ runs: [run], steps, generations: [] });
    const conflict = Object.assign(new Error('duplicate start'), { status: 409 });
    mocks.executeWorkflowRunnableNode.mockRejectedValue(conflict);

    const { syncTemplateRun } = await import('@/lib/template-run-service');
    const dto = await syncTemplateRun({ adminClient: db.client, runId: 'run-1', userId: 'user-1' });

    expect(db.writes.filter((write) => (
      write.table === 'template_run_steps' && write.payload.status === 'failed'
    ))).toHaveLength(0);
    expect(dto.status).toBe('queued');
  });
});

describe('cancelTemplateRun in-flight honesty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveStoredMediaUrl.mockImplementation(async (_client: unknown, value: string) => `signed:${value}`);
  });

  function seedProcessingRun() {
    const { run, steps } = seedTemplateRun();
    run.status = 'processing';
    const generationStep = steps.find((step) => step.kind === 'generation');
    if (!generationStep) throw new Error('Seed is missing a generation step.');
    generationStep.status = 'processing';
    generationStep.generation_id = 'generation-live';
    const generation: Row = {
      id: 'generation-live',
      status: 'processing',
      prediction_id: 'prediction-1',
      output_url: null,
      error_message: null,
      cost: 40,
      actual_cost: null,
      template_run_id: 'run-1',
      template_run_step_id: generationStep.id,
      created_at: '2026-08-18T00:00:00.000Z',
      completed_at: null,
    };
    return { run, steps, generation, generationStep };
  }

  it('records already-finished provider work as succeeded instead of cancelling it', async () => {
    const { run, steps, generation, generationStep } = seedProcessingRun();
    const db = createFakeSupabase({ runs: [run], steps, generations: [generation] });
    // The provider finished before the user cancelled; the sync discovers it.
    mocks.syncGenerationStatuses.mockImplementation(async () => {
      generation.status = 'succeeded';
      generation.output_url = 'generated_images/user-1/output.png';
      generation.actual_cost = 37;
      generation.completed_at = '2026-08-18T00:05:00.000Z';
    });

    const { cancelTemplateRun } = await import('@/lib/template-run-service');
    const dto = await cancelTemplateRun(db.client, 'run-1', 'user-1');

    expect(mocks.syncGenerationStatuses).toHaveBeenCalledWith(expect.objectContaining({
      generationIds: ['generation-live'],
    }));
    expect(dto.status).toBe('cancelled');
    const settledStep = dto.steps.find((step) => step.id === generationStep.id);
    expect(settledStep?.status).toBe('succeeded');
    expect(settledStep?.errorMessage).toBeNull();
    expect(dto.creditsUsed).toBe(37);
  });

  it('tells the user that genuinely in-flight steps keep their charge', async () => {
    const { run, steps, generationStep } = seedProcessingRun();
    const db = createFakeSupabase({
      runs: [run],
      steps,
      generations: [{
        id: 'generation-live',
        status: 'processing',
        prediction_id: 'prediction-1',
        output_url: null,
        error_message: null,
        cost: 40,
        actual_cost: null,
        template_run_id: 'run-1',
        template_run_step_id: generationStep.id,
        created_at: '2026-08-18T00:00:00.000Z',
        completed_at: null,
      }],
    });

    const { cancelTemplateRun } = await import('@/lib/template-run-service');
    const dto = await cancelTemplateRun(db.client, 'run-1', 'user-1');

    expect(dto.status).toBe('cancelled');
    const interrupted = dto.steps.find((step) => step.id === generationStep.id);
    expect(interrupted?.status).toBe('cancelled');
    expect(interrupted?.errorMessage).toMatch(/credits stay spent/i);
    const untouched = dto.steps.filter((step) => step.id !== generationStep.id);
    expect(untouched.every((step) => step.status === 'cancelled' && step.errorMessage === null)).toBe(true);
  });

  it('cancels cleanly even when the provider sync fails', async () => {
    const { run, steps, generation } = seedProcessingRun();
    const db = createFakeSupabase({ runs: [run], steps, generations: [generation] });
    mocks.syncGenerationStatuses.mockRejectedValue(new Error('provider status API down'));

    const { cancelTemplateRun } = await import('@/lib/template-run-service');
    const dto = await cancelTemplateRun(db.client, 'run-1', 'user-1');

    expect(dto.status).toBe('cancelled');
    expect(dto.steps.every((step) => ['cancelled', 'succeeded'].includes(step.status))).toBe(true);
  });
});

describe('quotePublishedGenerationModelAtRevision', () => {
  async function starterImageQuoteInput() {
    const graph = createTemplateReadyStarterGraph();
    const node = graph.nodes.find((candidate) => candidate.type === 'image-generate');
    if (!node) throw new Error('Starter image node is missing.');
    const data = normalizeNodeData('image-generate', node.data) as ImageGenerateNodeData;
    return {
      kind: 'image' as const,
      modelId: data.model,
      settings: {
        aspectRatio: data.aspectRatio,
        resolution: data.resolution,
        outputFormat: data.outputFormat,
        googleSearch: data.googleSearch,
      },
      inputCounts: { images: 1, videos: 0, audios: 0 },
    };
  }

  it('quotes identically to the live catalog when the pinned release is the live one', async () => {
    const store = await import('@/lib/generation-model-catalog-store');
    const input = await starterImageQuoteInput();
    const live = await store.quotePublishedGenerationModel(input, { platform: 'web' });
    const pinned = await store.quotePublishedGenerationModelAtRevision(input, {
      platform: 'web',
      revision: live.catalogRevision,
    });
    expect(pinned.costCredits).toBe(live.costCredits);
    expect(pinned.catalogRevision).toBe(live.catalogRevision);
  });

  it('raises a catalog error instead of a bare failure when the release is unavailable', async () => {
    const store = await import('@/lib/generation-model-catalog-store');
    const input = await starterImageQuoteInput();
    const attempt = store.quotePublishedGenerationModelAtRevision(input, {
      platform: 'web',
      revision: 'rev-that-never-existed',
    });
    await expect(attempt).rejects.toBeInstanceOf(CatalogError);
    await expect(attempt).rejects.toMatchObject({ code: 'CATALOG_CHANGED', status: 409 });
  });
});

describe('pinned-revision quoting seam', () => {
  const runnerSource = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/workflow-runner.ts'),
    'utf8',
  );
  const canvasRunSources = [
    'src/lib/workflow-runner.ts',
    'src/lib/workflow-run-route-service.ts',
  ].map((file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')).join('\n');

  it('quotes runnable nodes at the pinned revision only when the caller opts in', () => {
    expect(runnerSource).toContain('quoteAtPinnedRevision');
    expect(runnerSource).toContain('quotePublishedGenerationModelAtRevision');
  });

  it('never lets client-supplied canvas revisions opt into pinned pricing', () => {
    // Canvas runs store the CLIENT's catalogRevision, so pinned-revision
    // quoting there would let a stale or crafted client buy at old prices.
    // Only the template engine (server-compiled pins) may opt in.
    expect(canvasRunSources).not.toContain('quoteAtPinnedRevision: true');
  });

  it('opts the template engine into pinned-revision quoting', () => {
    const templateRunSource = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/template-run-service.ts'),
      'utf8',
    );
    expect(templateRunSource).toContain('quoteAtPinnedRevision: true');
  });
});
