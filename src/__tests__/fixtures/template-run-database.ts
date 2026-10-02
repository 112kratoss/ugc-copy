import type { SupabaseClient } from '@supabase/supabase-js';

import { validateAndCompileTemplateGraph } from '@/lib/template-graph-compiler';
import { createTemplateReadyStarterGraph } from '@/lib/workflow-canvas';

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'neq' | 'in'; column: string; value: unknown };
type DatabaseError = { code?: string; message: string };
type Answer<T> = { data: T | null; error: DatabaseError | null };

export const TEMPLATE_RUN_ID = 'run-1';
export const TEMPLATE_RUN_USER_ID = 'user-1';

const ACTIVE_GENERATION_STATUSES = ['pending', 'waiting', 'processing'];
const DEFAULT_START_FAILURE_MESSAGE =
  'The generation provider could not accept this request. Check the uploaded media and try again.';

function uniqueViolation(index: string): DatabaseError {
  return { code: '23505', message: `duplicate key value violates unique constraint "${index}"` };
}

/**
 * A queued run of the starter template: two image steps the worker starts in
 * one pass, then the approvals and the video step that wait on them.
 */
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

  const createdAt = new Date().toISOString();
  const run: Row = {
    id: TEMPLATE_RUN_ID,
    template_id: 'template-1',
    template_version_id: 'version-1',
    user_id: TEMPLATE_RUN_USER_ID,
    graph_snapshot: {
      ...compiled,
      catalogRevision: 'catalog-rev-1',
      templateId: 'template-1',
      templateVersionId: 'version-1',
      templateTitle: 'Starter template',
      sourceCanvasId: 'canvas-1',
      sourceCanvasRevision: 3,
      demoOutputUrl: null,
    },
    graph_hash: compiled.graphHash,
    input_manifest: compiled.inputSlots,
    input_storage_paths: Object.fromEntries(compiled.inputSlots.map((slot) => [
      slot.key,
      `template_inputs/${TEMPLATE_RUN_USER_ID}/${TEMPLATE_RUN_ID}/final/${slot.key}/input.png`,
    ])),
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
    catalog_revision: 'catalog-rev-1',
    completed_at: null,
    inputs_deleted_at: null,
    usage_counted_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };

  const nodes = (compiled.graph as { nodes?: Array<{ id: string; type: string; data: { title?: string } }> }).nodes ?? [];
  const steps: Row[] = nodes
    .filter((node) => ['image-generate', 'video-generate', 'approval-gate'].includes(node.type))
    .map((node, index) => ({
      id: `step-${index + 1}`,
      run_id: TEMPLATE_RUN_ID,
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
      created_at: createdAt,
    }));

  return { run, steps };
}

/**
 * The template run tables and the credit functions a step start goes through,
 * held in memory.
 *
 * `start_template_generation`, `settle_template_generation_start_failed` and
 * `attach_generation_provider_task` follow their migrations branch for
 * branch, and the two unique indexes a start can run into are enforced:
 * one generation per step row (`generations_template_run_step_unique_idx`)
 * and one step row per node and attempt. A worker that puts a step back in
 * line in a way the database would refuse is refused here too.
 * `template-run-step-busy-retry-database.test.ts` drives the same worker
 * against the real functions, so a port that drifts from them shows there.
 */
export function createTemplateRunDatabase(options: { credits?: number } = {}) {
  const { run, steps } = seedTemplateRun();
  const profile: Row = { id: TEMPLATE_RUN_USER_ID, credits: options.credits ?? 100 };
  const tables: Record<string, Row[]> = {
    template_runs: [run],
    template_run_steps: steps,
    generations: [],
    profiles: [profile],
  };
  const rpcCalls: Array<{ fn: string; args: Row; status: string | null; error: string | null }> = [];
  /** What the next ticks meet. Tests flip these between ticks. */
  const conditions = {
    /** Our own gate in front of the provider turns the submission away. */
    admissionRefused: false,
    /** The settlement of a refused start cannot be reached. */
    settlementUnavailable: false,
    /** The credit hold itself cannot be reached: nothing is reserved. */
    startUnavailable: false,
    /** A single generation cannot be read back. The worker loads a run's generations as a list. */
    generationUnreadable: false,
  };
  const now = () => new Date().toISOString();
  const answer = (status: string, extra: Row = {}): Answer<Row> => ({ data: { status, ...extra }, error: null });

  function startTemplateGeneration(args: Row): Answer<Row> {
    const cost = args.p_cost;
    if (typeof cost !== 'number' || cost < 0) return answer('invalid_cost');
    const category = String(args.p_category ?? '').trim();
    if (
      !args.p_user_id
      || !args.p_template_run_id
      || !args.p_template_run_step_id
      || !String(args.p_model ?? '').trim()
      || !['image', 'video'].includes(category)
      || (typeof args.p_duration === 'number' && args.p_duration < 0)
      || (args.p_creation_mode ?? null) !== null
    ) return answer('invalid_request');
    const key = (args.p_client_request_key_hash ?? null) as string | null;
    if (key !== null && !/^[a-f0-9]{64}$/.test(key)) return answer('invalid_idempotency_key');

    const templateRun = tables.template_runs.find((row) => row.id === args.p_template_run_id);
    if (!templateRun || templateRun.user_id !== args.p_user_id) return answer('template_context_not_found');
    if (['succeeded', 'failed', 'cancelled'].includes(String(templateRun.status))) {
      return answer('invalid_template_context');
    }
    const step = tables.template_run_steps.find((row) => (
      row.id === args.p_template_run_step_id && row.run_id === templateRun.id
    ));
    if (!step) return answer('template_context_not_found');
    if (step.kind !== 'generation' || step.media_kind !== category) return answer('invalid_template_context');
    if (!tables.profiles.includes(profile) || profile.id !== args.p_user_id) return answer('profile_not_found');

    const replayed = (existing: Row) => {
      const state = { generation_id: existing.id, remaining_credits: profile.credits, cost: existing.cost };
      if (existing.prediction_id !== null) {
        return answer('already_started', { ...state, prediction_id: existing.prediction_id });
      }
      return ACTIVE_GENERATION_STATUSES.includes(String(existing.status)) ? answer('in_progress', state) : null;
    };
    const keyAlreadyUsed = (existing: Row) => answer('key_already_used', {
      generation_id: existing.id, remaining_credits: profile.credits, cost: existing.cost,
    });

    // A step row that was started once is never started again.
    if (step.generation_id !== null) {
      const existing = tables.generations.find((row) => (
        row.id === step.generation_id
        && row.user_id === args.p_user_id
        && row.template_run_id === templateRun.id
        && row.template_run_step_id === step.id
      ));
      if (!existing || existing.client_request_key_hash !== key) return answer('template_step_already_started');
      return replayed(existing) ?? keyAlreadyUsed(existing);
    }
    if (step.status !== 'queued') return answer('invalid_template_context');

    if (key !== null) {
      const existing = tables.generations.find((row) => (
        row.user_id === args.p_user_id && row.client_request_key_hash === key
      ));
      if (existing) {
        if (existing.template_run_id === templateRun.id && existing.template_run_step_id === step.id) {
          step.generation_id = existing.id;
          if (ACTIVE_GENERATION_STATUSES.includes(String(existing.status))) step.status = 'processing';
          step.started_at ??= existing.created_at;
          const replay = replayed(existing);
          if (replay) return replay;
        }
        return keyAlreadyUsed(existing);
      }
    }

    if ((profile.credits as number) < cost) {
      return answer('insufficient_credits', { remaining_credits: profile.credits, required_credits: cost, cost });
    }
    // The function is one transaction: an insert the index refuses takes the
    // credit hold back with it, so nothing is held when this answers.
    if (tables.generations.some((row) => row.template_run_step_id === step.id)) {
      return { data: null, error: uniqueViolation('generations_template_run_step_unique_idx') };
    }
    profile.credits = (profile.credits as number) - cost;
    const generation: Row = {
      id: `gen-${tables.generations.length + 1}`,
      user_id: args.p_user_id,
      model: String(args.p_model).trim(),
      category,
      status: 'pending',
      prediction_id: null,
      output_url: null,
      error_message: null,
      cost,
      actual_cost: null,
      refunded: false,
      client_request_key_hash: key,
      template_run_id: templateRun.id,
      template_run_step_id: step.id,
      studio_visible: false,
      created_at: now(),
      completed_at: null,
    };
    tables.generations.push(generation);
    Object.assign(step, {
      generation_id: generation.id,
      status: 'processing',
      error_message: null,
      started_at: step.started_at ?? now(),
    });
    return answer('started', { generation_id: generation.id, remaining_credits: profile.credits, cost });
  }

  function settleTemplateGenerationStartFailed(args: Row): Answer<Row> {
    if (!args.p_generation_id) return answer('invalid_request');
    const generation = tables.generations.find((row) => row.id === args.p_generation_id);
    if (!generation) return answer('missing');
    if (generation.template_run_id === null || generation.template_run_step_id === null) {
      return answer('invalid_template_context');
    }
    if (generation.prediction_id !== null) {
      return answer('provider_task_attached', { generation_id: generation.id });
    }
    if (generation.status === 'succeeded') return answer('already_succeeded', { generation_id: generation.id });

    const message = (String(args.p_error_message ?? '').trim() || DEFAULT_START_FAILURE_MESSAGE).slice(0, 500);
    const refundedHere = generation.refunded !== true;
    if (refundedHere) profile.credits = (profile.credits as number) + Math.max(0, Number(generation.cost ?? 0));
    Object.assign(generation, {
      status: 'failed',
      error_message: message,
      completed_at: generation.completed_at ?? now(),
      refunded: true,
      client_request_key_hash: null,
    });
    // The settlement fails the step it was started for in the same statement.
    const step = tables.template_run_steps.find((row) => (
      row.id === generation.template_run_step_id
      && row.run_id === generation.template_run_id
      && row.generation_id === generation.id
      && row.status === 'processing'
    ));
    if (step) Object.assign(step, { status: 'failed', error_message: message, finished_at: step.finished_at ?? now() });
    return answer(refundedHere ? 'failed' : 'already_failed', {
      generation_id: generation.id, refunded: true, remaining_credits: profile.credits,
    });
  }

  function attachGenerationProviderTask(args: Row): Answer<Row> {
    const predictionId = String(args.p_prediction_id ?? '').trim();
    if (!args.p_generation_id || !predictionId) return answer('invalid_request');
    const generation = tables.generations.find((row) => row.id === args.p_generation_id);
    if (!generation) return answer('missing');
    if (['failed', 'succeeded'].includes(String(generation.status)) || generation.refunded === true) {
      return answer('already_settled', { generation_id: generation.id });
    }
    if (generation.prediction_id !== null) {
      return answer(generation.prediction_id === predictionId ? 'already_attached' : 'prediction_conflict', {
        generation_id: generation.id,
      });
    }
    if (tables.generations.some((row) => row.prediction_id === predictionId)) {
      return answer('prediction_conflict', { generation_id: generation.id });
    }
    Object.assign(generation, { prediction_id: predictionId, status: 'processing' });
    return answer('attached', { generation_id: generation.id, prediction_id: predictionId });
  }

  function call(fn: string, args: Row): Answer<unknown> {
    switch (fn) {
      case 'start_template_generation':
        return conditions.startUnavailable
          ? { data: null, error: { message: 'canceling statement due to statement timeout' } }
          : startTemplateGeneration(args);
      case 'settle_template_generation_start_failed':
        return conditions.settlementUnavailable
          ? { data: null, error: { message: 'settlement unavailable' } }
          : settleTemplateGenerationStartFailed(args);
      case 'attach_generation_provider_task':
        return attachGenerationProviderTask(args);
      case 'reserve_provider_submission':
        return {
          data: conditions.admissionRefused
            ? { allowed: false, reason: 'rate_limited', state: 'closed', retryAfterSeconds: 5, inFlight: 3 }
            : { allowed: true, reason: 'admitted', state: 'closed', retryAfterSeconds: 0, inFlight: 1 },
          error: null,
        };
      case 'record_provider_submission_outcome':
        return { data: null, error: null };
      default:
        // A function nobody ported would answer whatever the test happened to need.
        throw new Error(`Unexpected database function: ${fn}`);
    }
  }

  async function rpc(fn: string, args: Row = {}) {
    const result = call(fn, args);
    const data = result.data as Row | null;
    rpcCalls.push({
      fn,
      args,
      status: data && typeof data.status === 'string' ? data.status : null,
      error: result.error?.message ?? null,
    });
    return result;
  }

  function from(table: string) {
    if (!tables[table]) throw new Error(`Unexpected table: ${table}`);
    const filters: Filter[] = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let update: Row | null = null;
    let insert: Row[] | null = null;
    let result: Answer<Row[]> | null = null;

    const matches = (row: Row) => filters.every((filter) => {
      if (filter.op === 'eq') return row[filter.column] === filter.value;
      if (filter.op === 'neq') return row[filter.column] !== filter.value;
      return Array.isArray(filter.value) && filter.value.includes(row[filter.column]);
    });

    function insertRows(values: Row[]): Answer<Row[]> {
      if (table !== 'template_run_steps') throw new Error(`Unexpected insert into ${table}`);
      const inserted: Row[] = [];
      for (const value of values) {
        const taken = tables.template_run_steps.some((row) => (
          row.run_id === value.run_id && row.node_id === value.node_id && row.attempt === value.attempt
        ));
        if (taken) return { data: null, error: uniqueViolation('template_run_steps_run_id_node_id_attempt_key') };
        const row: Row = {
          id: `step-${tables.template_run_steps.length + 1}`,
          attempt: 0,
          status: 'queued',
          generation_id: null,
          output_url: null,
          error_message: null,
          can_retry: true,
          estimated_credits: 0,
          input_snapshot: null,
          output_snapshot: null,
          approved_at: null,
          started_at: null,
          finished_at: null,
          created_at: now(),
          ...value,
        };
        tables.template_run_steps.push(row);
        inserted.push(row);
      }
      return { data: inserted, error: null };
    }

    // A query runs once, when it is awaited, the way PostgREST runs it.
    const execute = (): Answer<Row[]> => {
      if (result) return result;
      if (insert) {
        result = insertRows(insert);
      } else {
        const rows = tables[table].filter(matches);
        if (update) for (const row of rows) Object.assign(row, update);
        for (const order of [...orders].reverse()) {
          rows.sort((left, right) => {
            const [a, b] = [left[order.column] as string | number, right[order.column] as string | number];
            return (a < b ? -1 : a > b ? 1 : 0) * (order.ascending ? 1 : -1);
          });
        }
        result = { data: rows, error: null };
      }
      // Rows are handed out as copies, as they are over the network.
      if (result.data) result = { data: result.data.map((row) => ({ ...row })), error: null };
      return result;
    };
    const one = (required: boolean): Answer<Row> => {
      if (table === 'generations' && conditions.generationUnreadable) {
        return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      }
      const { data, error } = execute();
      if (error) return { data: null, error };
      if ((data?.length ?? 0) > 1 || (required && !data?.length)) {
        return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      return { data: data?.[0] ?? null, error: null };
    };
    const filter = (op: Filter['op']) => (column: string, value: unknown) => {
      filters.push({ op, column, value });
      return query;
    };
    const query = {
      select: () => query,
      update(values: Row) {
        update = values;
        return query;
      },
      insert(values: Row | Row[]) {
        insert = Array.isArray(values) ? values : [values];
        return query;
      },
      eq: filter('eq'),
      neq: filter('neq'),
      in: filter('in'),
      order(column: string, orderOptions?: { ascending?: boolean }) {
        orders.push({ column, ascending: orderOptions?.ascending !== false });
        return query;
      },
      maybeSingle: async () => one(false),
      single: async () => one(true),
      then<T>(resolve: (value: Answer<Row[]>) => T) {
        return Promise.resolve(execute()).then(resolve);
      },
    };
    return query;
  }

  const client = {
    from,
    rpc,
    storage: {
      from: () => ({
        remove: async () => ({ error: null }),
        download: async () => ({ data: null, error: null }),
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((path) => ({ path, signedUrl: `https://storage.test/${path}`, error: null })),
          error: null,
        }),
      }),
    },
  } as unknown as SupabaseClient;

  const imageNodeIds = steps
    .filter((step) => step.kind === 'generation' && step.media_kind === 'image')
    .map((step) => step.node_id);

  return {
    client,
    conditions,
    rpcCalls,
    run,
    generations: tables.generations,
    steps: tables.template_run_steps,
    credits: () => profile.credits as number,
    /** Every attempt of each image step, oldest attempt first, in the order the worker starts the steps. */
    imageAttempts: () => imageNodeIds.map((nodeId) => (
      tables.template_run_steps
        .filter((step) => step.node_id === nodeId)
        .sort((left, right) => (left.attempt as number) - (right.attempt as number))
    )),
    /** The attempt of each image step the run is on now. */
    imageSteps() {
      return this.imageAttempts().map((attempts) => attempts[attempts.length - 1]);
    },
    starts: () => rpcCalls.filter((entry) => entry.fn === 'start_template_generation'),
    generationOf: (step: Row) => tables.generations.find((row) => row.id === step.generation_id) ?? null,
  };
}

export type TemplateRunDatabase = ReturnType<typeof createTemplateRunDatabase>;
