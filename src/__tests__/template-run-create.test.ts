import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink } from '@/lib/backend-logger';
import { createMediaTemplateRunsRouteHandlers } from '@/lib/media-template-route-adapter-service';
import type { TemplateVersionSnapshot } from '@/lib/media-template-types';
import { getTemplateStepDefinitions, validateAndCompileTemplateGraph } from '@/lib/template-graph-compiler';
import { createTemplateRun } from '@/lib/template-run-service';
import { createTemplateReadyStarterGraph } from '@/lib/workflow-canvas';

// The provider key is read once, when the generation modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
});

// The route is called as whoever a test names, against the database it holds.
// Its rate limit is a database function of its own.
const route = vi.hoisted(() => ({ client: null as unknown, userId: '' }));
vi.mock('@/lib/media-template-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media-template-api')>()),
  getTemplateApiAuth: async () => ({ userClient: null, adminClient: route.client, userId: route.userId }),
}));
vi.mock('@/lib/backend-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend-rate-limit')>()),
  enforceBackendRateLimit: async () => undefined,
}));

type Row = Record<string, unknown>;
type DatabaseError = { code: string; message: string };
type Answer = { data: Row | Row[] | null; error: DatabaseError | null };

const NOW = '2026-10-15T09:00:00.000Z';
const CREATOR_ID = '10000000-0000-4000-8000-000000000001';
const PERSON_ID = '20000000-0000-4000-8000-000000000002';
const TEMPLATE_ID = '30000000-0000-4000-8000-000000000003';
const VERSION_ID = '40000000-0000-4000-8000-000000000004';
const SLUG = 'product-reveal';

/** The published snapshot of the starter template: two images, two checkpoints, one video. */
function starterSnapshot(): TemplateVersionSnapshot {
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
  return {
    ...compiled,
    templateId: TEMPLATE_ID,
    templateVersionId: VERSION_ID,
    templateTitle: 'Product reveal',
    sourceCanvasId: 'canvas-1',
    sourceCanvasRevision: 3,
    demoOutputUrl: null,
  };
}

function uniqueViolation(index: string): DatabaseError {
  return { code: '23505', message: `duplicate key value violates unique constraint "${index}"` };
}

/**
 * The template, its published version and the run tables, held in memory.
 * The two unique indexes a run create can meet are enforced: one run per
 * person, template, test flag and request key
 * (`template_runs_create_idempotency_unique_idx`), and one step row per run,
 * node and attempt. A batch of step rows lands whole or not at all, as one
 * PostgREST insert does.
 */
function createDatabase(template: Row = {}) {
  const snapshot = starterSnapshot();
  const tables: Record<string, Row[]> = {
    templates: [{
      id: TEMPLATE_ID,
      slug: SLUG,
      name: 'Product reveal',
      creator_user_id: CREATOR_ID,
      status: 'active',
      is_active: true,
      active_version_id: VERSION_ID,
      ...template,
    }],
    template_versions: [{ id: VERSION_ID, template_id: TEMPLATE_ID, graph_snapshot: snapshot }],
    template_runs: [],
    template_run_steps: [],
    generations: [],
  };
  let runInsertAttempts = 0;
  // While a race is staged, each run insert waits until this many have
  // arrived, so every request has looked for a replay before any insert lands.
  let racingInserts = 0;
  const waitingInserts: Array<() => void> = [];

  function insertRun(values: Row): Answer {
    const key = values.client_request_key_hash ?? null;
    const taken = key !== null && tables.template_runs.some((row) => (
      row.user_id === values.user_id
      && row.template_id === values.template_id
      && row.is_test === values.is_test
      && row.client_request_key_hash === key
    ));
    if (taken) return { data: null, error: uniqueViolation('template_runs_create_idempotency_unique_idx') };
    const row: Row = {
      id: `run-${tables.template_runs.length + 1}`,
      status: 'collecting_inputs',
      input_storage_paths: {},
      credits_used: 0,
      result_url: null,
      result_generation_id: null,
      error_message: null,
      completed_at: null,
      inputs_deleted_at: null,
      usage_counted_at: null,
      created_at: NOW,
      updated_at: NOW,
      ...values,
    };
    tables.template_runs.push(row);
    return { data: [row], error: null };
  }

  function insertSteps(values: Row[]): Answer {
    const key = (row: Row) => `${String(row.run_id)}:${String(row.node_id)}:${String(row.attempt)}`;
    const existing = new Set(tables.template_run_steps.map(key));
    for (const value of values) {
      if (existing.has(key(value))) {
        return { data: null, error: uniqueViolation('template_run_steps_run_id_node_id_attempt_key') };
      }
      existing.add(key(value));
    }
    const rows = values.map((value, index) => ({
      id: `step-${tables.template_run_steps.length + index + 1}`,
      generation_id: null,
      output_url: null,
      error_message: null,
      input_snapshot: null,
      output_snapshot: null,
      approved_at: null,
      started_at: null,
      finished_at: null,
      created_at: NOW,
      ...value,
    }));
    tables.template_run_steps.push(...rows);
    return { data: rows, error: null };
  }

  async function waitForRace() {
    if (racingInserts === 0) return;
    await new Promise<void>((resolve) => {
      waitingInserts.push(resolve);
      if (waitingInserts.length === racingInserts) {
        racingInserts = 0;
        for (const release of waitingInserts.splice(0)) release();
      }
    });
  }

  function from(table: string) {
    if (!tables[table]) throw new Error(`Unexpected table: ${table}`);
    const filters: Array<[string, unknown]> = [];
    let insert: Row[] | null = null;
    let remove = false;

    // A query runs once, when it is awaited, the way PostgREST runs it.
    const execute = async (): Promise<Answer> => {
      if (insert) {
        if (table === 'template_runs') {
          runInsertAttempts += 1;
          await waitForRace();
          return insertRun(insert[0]!);
        }
        if (table === 'template_run_steps') return insertSteps(insert);
        throw new Error(`Unexpected insert into ${table}`);
      }
      const rows = tables[table]!.filter((row) => filters.every(([column, value]) => row[column] === value));
      if (remove) {
        tables[table] = tables[table]!.filter((row) => !rows.includes(row));
        return { data: null, error: null };
      }
      // Rows are handed out as copies, as they are over the network.
      return { data: rows.map((row) => ({ ...row })), error: null };
    };
    const one = async (required: boolean): Promise<Answer> => {
      const { data, error } = await execute();
      if (error) return { data: null, error };
      const rows = (data ?? []) as Row[];
      if (rows.length > 1 || (required && !rows.length)) {
        return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      return { data: rows[0] ?? null, error: null };
    };
    const query = {
      select: () => query,
      order: () => query,
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return query;
      },
      insert(values: Row | Row[]) {
        insert = Array.isArray(values) ? values : [values];
        return query;
      },
      delete() {
        remove = true;
        return query;
      },
      maybeSingle: () => one(false),
      single: () => one(true),
      then<T>(resolve: (value: Answer) => T, reject?: (reason: unknown) => T) {
        return execute().then(resolve, reject);
      },
    };
    return query;
  }

  return {
    client: { from } as unknown as SupabaseClient,
    snapshot,
    get runs() {
      return tables.template_runs;
    },
    get steps() {
      return tables.template_run_steps;
    },
    get runInsertAttempts() {
      return runInsertAttempts;
    },
    stageRace(requests: number) {
      racingInserts = requests;
    },
  };
}

type Database = ReturnType<typeof createDatabase>;

const NOT_LIVE = [
  ['draft', { status: 'draft', is_active: false, active_version_id: null }],
  ['disabled', { status: 'disabled', is_active: false }],
] as const;

describe('starting a run of a template', () => {
  let restoreLogSink: () => void;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Nothing here may reach the network.');
    }));
    restoreLogSink = setBackendLogSink(() => undefined);
  });
  afterEach(() => {
    restoreLogSink();
    vi.unstubAllGlobals();
    route.client = null;
    route.userId = '';
  });

  const start = (database: Database, idempotencyKey: string | null, body?: unknown) => createTemplateRun({
    client: database.client,
    templateId: TEMPLATE_ID,
    userId: PERSON_ID,
    idempotencyKey,
    body,
  });
  /** Each step node of the version, with how many step rows it has. */
  const stepRowsPerNode = (database: Database) => getTemplateStepDefinitions(database.snapshot)
    .map((definition) => database.steps.filter((step) => step.node_id === definition.nodeId).length);

  it('answers a repeated request key with the run it already made', async () => {
    const database = createDatabase();

    const first = await start(database, 'tap-1');
    const replay = await start(database, 'tap-1');
    // The same key sent in the body is the same request.
    const sentInBody = await start(database, null, { idempotencyKey: 'tap-1' });

    expect(first).toMatchObject({ templateId: TEMPLATE_ID, userId: PERSON_ID, status: 'collecting_inputs', isTest: false });
    expect(replay.id).toBe(first.id);
    expect(sentInBody.id).toBe(first.id);
    expect(database.runInsertAttempts).toBe(1);
    expect(database.runs).toHaveLength(1);
    expect(stepRowsPerNode(database).every((count) => count === 1)).toBe(true);

    const another = await start(database, 'tap-2');
    expect(another.id).not.toBe(first.id);
    expect(database.runs).toHaveLength(2);
  });

  it('settles two requests with one key that race past the replay check on one run', async () => {
    const database = createDatabase();
    database.stageRace(2);

    const [first, second] = await Promise.all([start(database, 'tap-1'), start(database, 'tap-1')]);

    expect(database.runInsertAttempts).toBe(2);
    expect(second.id).toBe(first.id);
    expect(database.runs).toHaveLength(1);
    expect(stepRowsPerNode(database).every((count) => count === 1)).toBe(true);
    expect(second.steps.map((step) => step.id)).toEqual(first.steps.map((step) => step.id));
  });

  it.each(NOT_LIVE)('answers 404 for a %s template and makes nothing', async (_label, state) => {
    const database = createDatabase(state);

    await expect(start(database, 'tap-1')).rejects.toMatchObject({
      status: 404,
      code: 'TEMPLATE_NOT_FOUND',
      message: 'Template not found.',
    });
    expect(database.runInsertAttempts).toBe(0);
    expect(database.runs).toHaveLength(0);
  });

  describe('through the run route', () => {
    const post = (database: Database, userId: string) => {
      route.client = database.client;
      route.userId = userId;
      return createMediaTemplateRunsRouteHandlers().POST(
        new Request(`https://magicbooklet.test/api/templates/${SLUG}/runs`, {
          method: 'POST',
          headers: { 'Idempotency-Key': 'tap-1' },
        }),
        { params: Promise.resolve({ id: SLUG }) },
      );
    };

    it.each(NOT_LIVE)('tells the creator their own %s template is not live', async (_label, state) => {
      const database = createDatabase(state);

      const response = await post(database, CREATOR_ID);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Template not found.', code: 'TEMPLATE_NOT_ACTIVE' });
      expect(database.runs).toHaveLength(0);
    });

    it.each(NOT_LIVE)('tells anyone else only that a %s template was not found', async (_label, state) => {
      const database = createDatabase(state);

      const response = await post(database, PERSON_ID);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Template not found.', code: 'TEMPLATE_NOT_FOUND' });
      expect(database.runs).toHaveLength(0);
    });

    it('makes the run of a live template, found by its slug', async () => {
      const database = createDatabase();

      const response = await post(database, PERSON_ID);

      expect(response.status).toBe(201);
      expect((await response.json()).run).toMatchObject({
        id: database.runs[0]!.id,
        templateId: TEMPLATE_ID,
        status: 'collecting_inputs',
      });
    });
  });
});
