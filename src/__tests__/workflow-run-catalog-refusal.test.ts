import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGenerationModelCatalog, CatalogError } from '@/lib/generation-model-catalog';
import {
  clearGenerationModelCatalogStoreCache,
  loadGenerationModelOperationByRevision,
} from '@/lib/generation-model-catalog-store';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';
import {
  createCanvasEdge,
  createWorkflowNode,
  normalizeWorkflowGraph,
  type ApprovalGateNodeData,
  type ImageGenerateNodeData,
  type TextInputNodeData,
} from '@/lib/workflow-canvas';
import { advanceWorkflowRunOnce } from '@/lib/workflow-runner';

// A canvas run step is priced against the published model catalog before any
// credits are held, and the catalog can turn it away: its model was switched
// off, the catalog has moved on from the revision the run was priced at, or a
// setting it asks for is gone. These cases run the real worker, the real
// catalog store and the real quote over a published release held in one small
// database. Only the start services, which a refused step never reaches, are
// stand-ins.

// The worker and the catalog store each make their own service client. Every
// test hands them the database its run lives in.
const service = vi.hoisted(() => ({ client: null as unknown }));

type StartResult = { predictionId: string; remainingCredits: number; cost: number; generationId: string };
const starts = vi.hoisted(() => ({
  image: vi.fn<(params: Record<string, unknown>) => Promise<StartResult>>(),
  catalog: vi.fn<(params: Record<string, unknown>) => Promise<StartResult>>(),
}));

vi.mock('@/lib/server-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server-helpers')>()),
  createServiceClient: () => service.client,
}));

vi.mock('@/lib/generation-services', () => ({
  startImageGeneration: (params: Record<string, unknown>) => starts.image(params),
  startCatalogGeneration: (params: Record<string, unknown>) => starts.catalog(params),
  startMotionGeneration: vi.fn(),
  startSoundEffectGeneration: vi.fn(),
  startVideoGeneration: vi.fn(),
  startVoiceoverGeneration: vi.fn(),
}));

vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: vi.fn(async () => undefined),
}));

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'in'; column: string; value: unknown };

const ACTIVE_REVISION = 'imagen-family-switched-off';
const RETIRED_REVISION = 'before-imagen-family-switched-off';
// What release `imagen-family-disable-20260824` did: the three models stay in
// the release and in the bundled registry, and are offered on no platform.
const SWITCHED_OFF = ['imagen-4', 'imagen-4-fast', 'imagen-4-ultra'];

const OUTAGE_NOTE = /temporarily unavailable/i;
const REFUSED_BY_PROVIDER_NOTE = /provider could not accept|template inputs/i;
const CHOOSE_ANOTHER_MODEL = /no longer available.*choose another model/i;
const RELOAD_MODEL_SETTINGS = /model settings have changed.*reload the page/i;
const UPDATE_MODEL_SETTINGS = /model settings for this step.*update them/i;

/** A release as the catalog tables store it, built from the bundled catalog. */
function releaseRows(release: { id: string; revision: string; status: 'active' | 'retired'; switchedOff: string[] }) {
  const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 });
  const operations = new Map(buildCodeGenerationModelOperations().map((operation) => [operation.modelId, operation]));
  return {
    release: {
      id: release.id,
      schema_version: 2,
      revision: release.revision,
      status: release.status,
      defaults: { web: catalog.defaults, mobile: catalog.defaults },
    } satisfies Row,
    entries: catalog.models.map((descriptor): Row => {
      const operation = operations.get(descriptor.id);
      if (!operation) throw new Error(`The bundled catalog has no operation for ${descriptor.id}.`);
      const offered = !release.switchedOff.includes(descriptor.id);
      return {
        release_id: release.id,
        model_id: descriptor.id,
        public_descriptor: descriptor,
        web_enabled: offered,
        mobile_enabled: offered,
        adapter_key: operation.adapterKey,
        adapter_config: operation.adapterConfig,
        provider_model_map: operation.providerModelMap,
        pricing_strategy: operation.pricingStrategy,
        pricing_config: operation.pricingConfig,
        validation_strategy: operation.validationStrategy,
        validation_config: operation.validationConfig,
        verification_config: operation.verificationConfig,
      };
    }),
  };
}

/**
 * A workflow run of prompt, image, approval checkpoint, beside the published
 * catalog it is priced against. The checkpoint depends on the image, so it
 * shows whether the image step is still in line (`queued`) or has ended
 * (`blocked`).
 */
function createRunDatabase(options: {
  model: string;
  /** The revision the editor sent when the run was started; null when it sent none. */
  catalogRevision: string | null;
  /** Settings the editor recorded for the catalog. Any at all move the node onto the catalog's own execution path. */
  catalogSettings?: Record<string, string>;
}) {
  const prompt = createWorkflowNode('text-input', { x: 40, y: 40 });
  const image = createWorkflowNode('image-generate', { x: 280, y: 40 });
  const gate = createWorkflowNode('approval-gate', { x: 520, y: 40 });
  const graph = normalizeWorkflowGraph({
    nodes: [
      { ...prompt, data: { ...(prompt.data as TextInputNodeData), text: 'A ceramic mug on a linen cloth' } },
      {
        ...image,
        data: {
          ...(image.data as ImageGenerateNodeData),
          model: options.model as ImageGenerateNodeData['model'],
          ...(options.catalogSettings ? { catalogSettings: options.catalogSettings } : {}),
        },
      },
      { ...gate, data: { ...(gate.data as ApprovalGateNodeData), mediaKind: 'image', label: 'Review the mug' } },
    ],
    edges: [
      createCanvasEdge(prompt.id, 'text', image.id, 'prompt'),
      createCanvasEdge(image.id, 'image', gate.id, 'image'),
    ],
  });
  const queuedStep = (id: string, nodeId: string): Row => ({
    id,
    run_id: 'run-1',
    node_id: nodeId,
    status: 'queued',
    generation_id: null,
    input_snapshot: null,
    output_snapshot: null,
    error_message: null,
    started_at: null,
    finished_at: null,
  });

  const active = releaseRows({ id: 'release-active', revision: ACTIVE_REVISION, status: 'active', switchedOff: SWITCHED_OFF });
  const retired = releaseRows({ id: 'release-retired', revision: RETIRED_REVISION, status: 'retired', switchedOff: [] });
  const tables: Record<string, Row[]> = {
    generation_model_catalog_releases: [active.release, retired.release],
    generation_model_catalog_entries: [...active.entries, ...retired.entries],
    workflow_canvas_runs: [{
      id: 'run-1',
      canvas_id: 'canvas-1',
      user_id: 'user-1',
      start_node_id: image.id,
      mode: 'branch',
      status: 'processing',
      created_at: '2026-10-02T10:00:00.000Z',
      finished_at: null,
      catalog_revision: options.catalogRevision,
      graph_snapshot: graph,
    }],
    workflow_canvas_run_steps: [queuedStep('step-image', image.id), queuedStep('step-gate', gate.id)],
    generations: [],
  };
  const state = {
    /** Reads of the published release that are refused, as a database that does not answer in time would. */
    catalogReadsToRefuse: 0,
    catalogReads: 0,
  };

  function from(table: string) {
    if (!tables[table]) throw new Error(`Unexpected table: ${table}`);
    const filters: Filter[] = [];
    let update: Row | null = null;
    const run = (): { rows: Row[]; error: { message: string; code: string } | null } => {
      if (table === 'generation_model_catalog_releases') {
        state.catalogReads += 1;
        if (state.catalogReadsToRefuse > 0) {
          state.catalogReadsToRefuse -= 1;
          return { rows: [], error: { message: 'canceling statement due to statement timeout', code: '57014' } };
        }
      }
      const rows = tables[table].filter((row) => filters.every((filter) => (
        filter.op === 'eq'
          ? row[filter.column] === filter.value
          : Array.isArray(filter.value) && filter.value.includes(row[filter.column])
      )));
      if (update) for (const row of rows) Object.assign(row, update);
      return { rows, error: null };
    };
    const query = {
      select: () => query,
      update(values: Row) {
        update = values;
        return query;
      },
      eq(column: string, value: unknown) {
        filters.push({ op: 'eq', column, value });
        return query;
      },
      in(column: string, value: unknown[]) {
        filters.push({ op: 'in', column, value });
        return query;
      },
      order: () => query,
      limit: () => query,
      async single() {
        const { rows, error } = run();
        if (error) return { data: null, error };
        return rows[0] ? { data: { ...rows[0] }, error: null } : { data: null, error: { message: 'No rows found' } };
      },
      async maybeSingle() {
        const { rows, error } = run();
        return error ? { data: null, error } : { data: rows[0] ? { ...rows[0] } : null, error: null };
      },
      then(resolve: (value: { data: Row[] | null; error: { message: string } | null }) => unknown) {
        const { rows, error } = run();
        return resolve(error ? { data: null, error } : { data: rows.map((row) => ({ ...row })), error: null });
      },
    };
    return query;
  }

  const client = { from } as unknown as SupabaseClient;
  service.client = client;

  const step = (id: string) => {
    const row = tables.workflow_canvas_run_steps.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`No stored step ${id}`);
    return row;
  };

  return {
    state,
    run: () => tables.workflow_canvas_runs[0],
    imageStep: () => step('step-image'),
    gateStep: () => step('step-gate'),
    advance: () => advanceWorkflowRunOnce({ supabase: client, canvasId: 'canvas-1', runId: 'run-1' }),
  };
}

type RunDatabase = ReturnType<typeof createRunDatabase>;

/** The image step has ended with what the creator has to change, and the run with it. */
function expectStepEnded(db: RunDatabase, run: Awaited<ReturnType<RunDatabase['advance']>>, remedy: RegExp) {
  expect(db.imageStep()).toMatchObject({
    status: 'failed',
    generation_id: null,
    error_message: expect.stringMatching(remedy),
    started_at: expect.any(String),
    finished_at: expect.any(String),
  });
  // The provider was never asked, so the step says neither that it is down
  // nor that it refused the request.
  expect(db.imageStep().error_message).not.toMatch(OUTAGE_NOTE);
  expect(db.imageStep().error_message).not.toMatch(REFUSED_BY_PROVIDER_NOTE);
  expect(db.gateStep()).toMatchObject({ status: 'blocked', finished_at: expect.any(String) });
  expect(run.status).toBe('failed');
  expect(db.run()).toMatchObject({ status: 'failed', finished_at: expect.any(String) });
  // Refused before the start service: no credits were held, nothing was sent.
  expect(starts.image).not.toHaveBeenCalled();
  expect(starts.catalog).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'database');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
  // The store keeps the published release for a minute.
  clearGenerationModelCatalogStoreCache();
  const started = { predictionId: 'task-1', remainingCredits: 488, cost: 12, generationId: 'gen-1' };
  starts.image.mockReset().mockResolvedValue(started);
  starts.catalog.mockReset().mockResolvedValue(started);
});

afterEach(() => {
  vi.unstubAllEnvs();
  service.client = null;
});

describe('a canvas run step whose model the catalog no longer offers', () => {
  it.each([
    [
      'on its model’s own execution path',
      { model: 'imagen-4', catalogRevision: ACTIVE_REVISION },
    ],
    [
      'when the run names no catalog revision',
      { model: 'imagen-4', catalogRevision: null },
    ],
    [
      'on the catalog’s execution path',
      { model: 'imagen-4-ultra', catalogRevision: ACTIVE_REVISION, catalogSettings: { aspectRatio: '1:1' } },
    ],
  ])('ends, and tells the creator to choose another model: %s', async (_path, saved) => {
    const db = createRunDatabase(saved);

    const run = await db.advance();

    // Read as a provider outage, the step would stay `queued` under that note
    // and be tried again on every tick for as long as a busy provider is
    // waited on.
    expectStepEnded(db, run, CHOOSE_ANOTHER_MODEL);

    // A later tick finds nothing to try: the step and what it says are as they were.
    const ended = structuredClone(db.imageStep());
    await db.advance();
    expect(db.imageStep()).toEqual(ended);
    expect(starts.image).not.toHaveBeenCalled();
    expect(starts.catalog).not.toHaveBeenCalled();
  });

  it('is named by the catalog as its own refusal, not as a bare failure', async () => {
    createRunDatabase({ model: 'imagen-4', catalogRevision: ACTIVE_REVISION });

    const lookup = loadGenerationModelOperationByRevision({ modelId: 'imagen-4', revision: ACTIVE_REVISION });

    // A bare error whose text says "unavailable" reads as a provider outage to
    // whoever classifies it; the run workers end a step on this class.
    await expect(lookup).rejects.toBeInstanceOf(CatalogError);
    await expect(lookup).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', status: 409 });
    // The same model in the release that still offered it.
    await expect(loadGenerationModelOperationByRevision({ modelId: 'imagen-4', revision: RETIRED_REVISION }))
      .resolves.toMatchObject({ operation: { modelId: 'imagen-4' } });
  });
});

describe('a canvas run step the catalog refuses for another reason', () => {
  it.each([
    [
      'on its model’s own execution path',
      { model: 'nano-banana-2', catalogRevision: RETIRED_REVISION },
    ],
    [
      'on the catalog’s execution path',
      { model: 'nano-banana-2', catalogRevision: RETIRED_REVISION, catalogSettings: { aspectRatio: '1:1' } },
    ],
  ])('ends when the catalog has moved on from the release the run was priced at: %s', async (_path, saved) => {
    const db = createRunDatabase(saved);

    const run = await db.advance();

    expectStepEnded(db, run, RELOAD_MODEL_SETTINGS);
  });

  it('ends when the step asks for a setting its model does not offer', async () => {
    const db = createRunDatabase({
      model: 'nano-banana-2',
      catalogRevision: ACTIVE_REVISION,
      catalogSettings: { aspectRatio: 'a-ratio-this-model-never-offered' },
    });

    const run = await db.advance();

    expectStepEnded(db, run, UPDATE_MODEL_SETTINGS);
  });
});

describe('a canvas run step the catalog does not refuse', () => {
  it.each([
    [
      'on its model’s own execution path',
      { model: 'nano-banana-2', catalogRevision: ACTIVE_REVISION },
      starts.image,
    ],
    [
      'on the catalog’s execution path',
      { model: 'nano-banana-2', catalogRevision: ACTIVE_REVISION, catalogSettings: { aspectRatio: '1:1' } },
      starts.catalog,
    ],
  ])('is priced by the published release and started: %s', async (_path, saved, start) => {
    const db = createRunDatabase(saved);

    const run = await db.advance();

    expect(start).toHaveBeenCalledTimes(1);
    const quotedCostCredits = start.mock.calls[0][0].quotedCostCredits;
    expect(quotedCostCredits).toEqual(expect.any(Number));
    expect(quotedCostCredits).toBeGreaterThan(0);
    expect(db.imageStep()).toMatchObject({ status: 'processing', generation_id: 'gen-1', error_message: null, finished_at: null });
    expect(db.gateStep()).toMatchObject({ status: 'queued', finished_at: null });
    expect(run.status).toBe('processing');
  });

  it('keeps its place in the queue while the catalog cannot be read, and starts once it can', async () => {
    const db = createRunDatabase({ model: 'nano-banana-2', catalogRevision: ACTIVE_REVISION });
    db.state.catalogReadsToRefuse = 1;

    const waiting = await db.advance();

    // The database behind the catalog did not answer. That passes, which a
    // refusal the catalog made never does.
    expect(db.state.catalogReads).toBe(1);
    expect(db.imageStep()).toMatchObject({
      status: 'queued',
      generation_id: null,
      error_message: expect.stringMatching(OUTAGE_NOTE),
      finished_at: null,
    });
    expect(db.gateStep()).toMatchObject({ status: 'queued' });
    expect(waiting.status).toBe('processing');
    expect(db.run()).toMatchObject({ status: 'processing', finished_at: null });
    expect(starts.image).not.toHaveBeenCalled();

    const started = await db.advance();

    expect(starts.image).toHaveBeenCalledTimes(1);
    expect(db.imageStep()).toMatchObject({ status: 'processing', generation_id: 'gen-1', error_message: null });
    expect(started.status).toBe('processing');
  });
});
