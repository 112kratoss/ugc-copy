import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  syncGenerationStatuses,
} from '@/lib/generation-services';
import {
  getPublicGenerationStartFailure,
  normalizeGenerationStartFailureCode,
  requiresReplacementGenerationInput,
  type GenerationStartFailureCode,
} from '@/lib/generation-public-failure';
import {
  loadCompiledDraftForTemplate,
  loadMediaTemplateRow,
} from '@/lib/media-template-service';
import {
  isRecord,
  MediaTemplateError,
  type CompiledTemplateGraph,
  type TemplateInputSlot,
  type TemplateMediaKind,
  type TemplateRunDto,
  type TemplateRunStatus,
  type TemplateVersionSnapshot,
} from '@/lib/media-template-types';
import {
  getTemplateStepDefinitions,
} from '@/lib/template-graph-compiler';
import {
  getTemplateInputExtensions,
  validateTemplateInputBlob,
  validateTemplateInputDescriptor,
} from '@/lib/template-input-preflight';
import { resolveStoredMediaUrl } from '@/lib/server-helpers';
import {
  getIncomingEdges,
  getNodeById,
  inspectWorkflowNodeDependencies,
  isApprovalGateNode,
  normalizeWorkflowGraph,
  updateNodeRunState,
  type ApprovalGateNodeData,
  type ImageInputNodeData,
  type VideoInputNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
} from '@/lib/workflow-canvas';
import { executeWorkflowRunnableNode } from '@/lib/workflow-runner';

const TEMPLATE_INPUT_BUCKET = 'template_inputs' as const;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const ACTIVE_GENERATION_STATUSES = new Set(['pending', 'waiting', 'processing']);
const TERMINAL_RUN_STATUSES = new Set<TemplateRunStatus>(['succeeded', 'failed', 'cancelled']);

const RUN_SELECT = [
  'id', 'template_id', 'template_version_id', 'user_id', 'graph_snapshot',
  'graph_hash', 'input_manifest', 'input_storage_paths', 'output_node_id',
  'output_kind', 'status', 'estimated_total_credits',
  'estimated_remaining_credits', 'credits_used', 'result_url',
  'result_generation_id',
  'error_message', 'is_test', 'source_canvas_revision', 'catalog_revision',
  'completed_at', 'inputs_deleted_at', 'usage_counted_at', 'created_at',
  'updated_at',
].join(', ');

const STEP_SELECT = [
  'id', 'run_id', 'node_id', 'attempt', 'kind', 'media_kind', 'label',
  'status', 'generation_id', 'output_url', 'error_message', 'can_retry',
  'estimated_credits', 'input_snapshot', 'output_snapshot', 'approved_at',
  'started_at', 'finished_at', 'created_at',
].join(', ');

const GENERATION_SELECT = [
  'id', 'status', 'prediction_id', 'output_url', 'error_message', 'cost',
  'actual_cost', 'template_run_id', 'template_run_step_id', 'created_at',
  'completed_at',
].join(', ');

type TemplateRunRow = {
  id: string;
  template_id: string;
  template_version_id: string | null;
  user_id: string;
  graph_snapshot: unknown;
  graph_hash: string;
  input_manifest: unknown;
  input_storage_paths: unknown;
  output_node_id: string;
  output_kind: TemplateMediaKind;
  status: TemplateRunStatus;
  estimated_total_credits: number;
  estimated_remaining_credits: number;
  credits_used: number;
  result_url: string | null;
  result_generation_id: string | null;
  error_message: string | null;
  is_test: boolean;
  source_canvas_revision: number | null;
  catalog_revision: string | null;
  completed_at: string | null;
  inputs_deleted_at: string | null;
  usage_counted_at: string | null;
  created_at: string;
  updated_at: string;
};

type TemplateRunStepRow = {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  kind: 'generation' | 'approval';
  media_kind: TemplateMediaKind;
  label: string;
  status: 'queued' | 'processing' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled';
  generation_id: string | null;
  output_url: string | null;
  error_message: string | null;
  can_retry: boolean;
  estimated_credits: number;
  input_snapshot: unknown;
  output_snapshot: unknown;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type GenerationRow = {
  id: string;
  status: string;
  prediction_id: string | null;
  output_url: string | null;
  error_message: string | null;
  cost: number | null;
  actual_cost: number | null;
  template_run_id: string | null;
  template_run_step_id: string | null;
  created_at: string;
  completed_at: string | null;
};

type RunState = {
  run: TemplateRunRow;
  snapshot: TemplateVersionSnapshot;
  steps: TemplateRunStepRow[];
  latestSteps: Map<string, TemplateRunStepRow>;
  generations: Map<string, GenerationRow>;
};

function asInputSlots(value: unknown): TemplateInputSlot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const key = typeof entry.key === 'string' ? entry.key : '';
    const kind = entry.kind === 'image' || entry.kind === 'video' ? entry.kind : null;
    const label = typeof entry.label === 'string' ? entry.label : '';
    if (!key || !kind || !label) return [];
    const description = typeof entry.description === 'string' && entry.description.trim()
      ? entry.description.trim()
      : undefined;
    return [{ key, kind, label, ...(description ? { description } : {}), required: true as const }];
  });
}

function asStoragePaths(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])));
}

function asSnapshot(run: TemplateRunRow): TemplateVersionSnapshot {
  if (!isRecord(run.graph_snapshot) || !isRecord(run.graph_snapshot.graph)) {
    throw new MediaTemplateError('Template run configuration is invalid.', 500, 'INVALID_RUN_SNAPSHOT');
  }
  const value = run.graph_snapshot;
  return {
    ...(value as unknown as TemplateVersionSnapshot),
    graph: value.graph as Record<string, unknown>,
    graphHash: typeof value.graphHash === 'string' ? value.graphHash : run.graph_hash,
    outputNodeId: typeof value.outputNodeId === 'string' ? value.outputNodeId : run.output_node_id,
    outputKind: value.outputKind === 'image' || value.outputKind === 'video'
      ? value.outputKind
      : run.output_kind,
    inputSlots: asInputSlots(value.inputSlots ?? run.input_manifest),
    inputNodeIds: isRecord(value.inputNodeIds)
      ? Object.fromEntries(Object.entries(value.inputNodeIds)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {},
    nodeCosts: isRecord(value.nodeCosts)
      ? Object.fromEntries(Object.entries(value.nodeCosts)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
      : {},
    estimatedTotalCredits: typeof value.estimatedTotalCredits === 'number'
      ? value.estimatedTotalCredits
      : run.estimated_total_credits,
    catalogRevision: typeof value.catalogRevision === 'string' ? value.catalogRevision : run.catalog_revision,
    templateId: typeof value.templateId === 'string' ? value.templateId : run.template_id,
    templateVersionId: typeof value.templateVersionId === 'string' ? value.templateVersionId : run.template_version_id,
    templateTitle: typeof value.templateTitle === 'string' ? value.templateTitle : 'Template creation',
    sourceCanvasId: typeof value.sourceCanvasId === 'string' ? value.sourceCanvasId : '',
    sourceCanvasRevision: typeof value.sourceCanvasRevision === 'number'
      ? value.sourceCanvasRevision
      : run.source_canvas_revision ?? 0,
  };
}

function latestStepsByNode(steps: TemplateRunStepRow[]) {
  const latest = new Map<string, TemplateRunStepRow>();
  for (const step of steps) {
    const current = latest.get(step.node_id);
    if (!current || step.attempt > current.attempt) latest.set(step.node_id, step);
  }
  return latest;
}

function stepFailureCode(step: TemplateRunStepRow): GenerationStartFailureCode | null {
  if (!isRecord(step.output_snapshot)) return null;
  return normalizeGenerationStartFailureCode(step.output_snapshot.failureCode);
}

function failureSnapshot(step: TemplateRunStepRow, failureCode: GenerationStartFailureCode) {
  return {
    ...(isRecord(step.output_snapshot) ? step.output_snapshot : {}),
    failureCode,
  };
}

async function loadOwnedRun(client: SupabaseClient, runId: string, userId: string): Promise<TemplateRunRow> {
  const { data, error } = await client.from('template_runs').select(RUN_SELECT)
    .eq('id', runId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new MediaTemplateError('Template run not found.', 404, 'RUN_NOT_FOUND');
  return data as unknown as TemplateRunRow;
}

async function loadRunSteps(client: SupabaseClient, runId: string): Promise<TemplateRunStepRow[]> {
  const { data, error } = await client.from('template_run_steps').select(STEP_SELECT)
    .eq('run_id', runId).order('attempt', { ascending: true }).order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as TemplateRunStepRow[];
}

async function loadRunGenerations(client: SupabaseClient, runId: string): Promise<Map<string, GenerationRow>> {
  const { data, error } = await client.from('generations').select(GENERATION_SELECT)
    .eq('template_run_id', runId);
  if (error) throw error;
  return new Map(((data ?? []) as unknown as GenerationRow[]).map((row) => [row.id, row]));
}

async function loadRunState(client: SupabaseClient, runId: string, userId: string): Promise<RunState> {
  const run = await loadOwnedRun(client, runId, userId);
  const [steps, generations] = await Promise.all([
    loadRunSteps(client, run.id),
    loadRunGenerations(client, run.id),
  ]);
  return {
    run,
    snapshot: asSnapshot(run),
    steps,
    latestSteps: latestStepsByNode(steps),
    generations,
  };
}

function generationCredits(generations: Iterable<GenerationRow>): number {
  let credits = 0;
  for (const generation of generations) {
    if (typeof generation.actual_cost === 'number') credits += Math.max(0, generation.actual_cost);
    else if (generation.status !== 'failed') credits += Math.max(0, generation.cost ?? 0);
  }
  return credits;
}

async function toRunDto(client: SupabaseClient, state: RunState): Promise<TemplateRunDto> {
  const inputSlots = asInputSlots(state.run.input_manifest);
  const storedInputs = asStoragePaths(state.run.input_storage_paths);
  const publicInputs = Object.fromEntries(inputSlots.flatMap((slot) => storedInputs[slot.key]
    ? [[slot.key, 'uploaded']]
    : []));
  const graph = normalizeWorkflowGraph(state.snapshot.graph as Partial<WorkflowCanvasGraph>);
  const orderedLatestSteps = topologicalNodes(graph).flatMap((node) => {
    const step = state.latestSteps.get(node.id);
    return step ? [step] : [];
  });
  const steps = await Promise.all(orderedLatestSteps.map(async (step) => ({
    id: step.id,
    kind: step.kind,
    mediaKind: step.media_kind,
    status: step.status,
    label: step.label,
    outputUrl: step.output_url ? await resolveStoredMediaUrl(client, step.output_url) : null,
    errorMessage: step.error_message,
    failureCode: stepFailureCode(step),
    canRetry: step.can_retry && (step.status === 'failed' || step.status === 'awaiting_approval'),
    estimatedRetryCredits: Math.max(0, step.estimated_credits),
  })));
  const resultUrl = state.run.result_url
    ? await resolveStoredMediaUrl(client, state.run.result_url)
    : null;
  return {
    id: state.run.id,
    templateId: state.run.template_id,
    templateTitle: state.snapshot.templateTitle,
    userId: state.run.user_id,
    status: state.run.status,
    inputSlots,
    inputs: publicInputs,
    steps,
    result: resultUrl && state.run.result_generation_id
      ? {
        generationId: state.run.result_generation_id,
        kind: state.run.output_kind,
        url: resultUrl,
      }
      : null,
    estimatedTotalCredits: Math.max(0, state.run.estimated_total_credits),
    estimatedRemainingCredits: Math.max(0, state.run.estimated_remaining_credits),
    creditsUsed: Math.max(0, state.run.credits_used || generationCredits(state.generations.values())),
    errorMessage: state.run.error_message,
    isTest: Boolean(state.run.is_test),
    createdAt: state.run.created_at,
    updatedAt: state.run.updated_at,
  };
}

function createSnapshot(params: {
  compiled: CompiledTemplateGraph;
  templateId: string;
  templateVersionId: string | null;
  templateTitle: string;
  sourceCanvasId: string;
  sourceCanvasRevision: number;
}): TemplateVersionSnapshot {
  return {
    ...params.compiled,
    templateId: params.templateId,
    templateVersionId: params.templateVersionId,
    templateTitle: params.templateTitle,
    sourceCanvasId: params.sourceCanvasId,
    sourceCanvasRevision: params.sourceCanvasRevision,
    demoOutputUrl: null,
  };
}

async function insertRunWithSteps(params: {
  client: SupabaseClient;
  templateId: string;
  templateVersionId: string | null;
  userId: string;
  snapshot: TemplateVersionSnapshot;
  isTest: boolean;
  clientRequestKeyHash: string | null;
}) {
  const { client, snapshot } = params;
  const { data, error } = await client.from('template_runs').insert({
    template_id: params.templateId,
    template_version_id: params.templateVersionId,
    user_id: params.userId,
    graph_snapshot: snapshot,
    graph_hash: snapshot.graphHash,
    input_manifest: snapshot.inputSlots,
    output_node_id: snapshot.outputNodeId,
    output_kind: snapshot.outputKind,
    estimated_total_credits: snapshot.estimatedTotalCredits,
    estimated_remaining_credits: snapshot.estimatedTotalCredits,
    is_test: params.isTest,
    client_request_key_hash: params.clientRequestKeyHash,
    source_canvas_revision: snapshot.sourceCanvasRevision,
    catalog_revision: snapshot.catalogRevision,
  }).select(RUN_SELECT).single();
  let inserted = true;
  let run = data as unknown as TemplateRunRow | null;
  if (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    if (code !== '23505' || !params.clientRequestKeyHash) throw error;
    const { data: existing, error: existingError } = await client.from('template_runs')
      .select(RUN_SELECT)
      .eq('user_id', params.userId)
      .eq('template_id', params.templateId)
      .eq('is_test', params.isTest)
      .eq('client_request_key_hash', params.clientRequestKeyHash)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) throw error;
    inserted = false;
    run = existing as unknown as TemplateRunRow;
  }
  if (!run) throw new MediaTemplateError('Failed to create template run.', 500, 'RUN_CREATE_FAILED');
  const definitions = getTemplateStepDefinitions(snapshot);
  if (!definitions.length) {
    if (inserted) await client.from('template_runs').delete().eq('id', run.id);
    throw new MediaTemplateError('The template has no runnable media steps.', 400, 'EMPTY_TEMPLATE_RUN');
  }
  const existingSteps = await loadRunSteps(client, run.id);
  const existingKeys = new Set(existingSteps.map((step) => `${step.node_id}:${step.attempt}`));
  const missingDefinitions = definitions.filter((definition) => !existingKeys.has(`${definition.nodeId}:0`));
  const { error: stepError } = missingDefinitions.length
    ? await client.from('template_run_steps').insert(missingDefinitions.map((definition) => ({
    run_id: run.id,
    node_id: definition.nodeId,
    attempt: 0,
    kind: definition.kind,
    media_kind: definition.mediaKind,
    label: definition.label,
    status: 'queued',
    can_retry: definition.canRetry,
    estimated_credits: definition.estimatedCredits,
  })))
    : { error: null };
  const stepErrorCode = isRecord(stepError) && typeof stepError.code === 'string' ? stepError.code : '';
  if (stepError && stepErrorCode !== '23505') {
    if (inserted) await client.from('template_runs').delete().eq('id', run.id);
    throw stepError;
  }
  return loadRunState(client, run.id, params.userId);
}

function getTemplateRunIdempotencyKey(params: {
  body: unknown;
  headerKey?: string | null;
}): string | null {
  const body = isRecord(params.body) ? params.body : {};
  const bodyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null;
  const normalize = (value: string | null | undefined, source: string) => {
    if (value == null) return null;
    const key = value.trim();
    if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new MediaTemplateError(
        `${source} idempotency key must contain 1–${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
        400,
        'INVALID_IDEMPOTENCY_KEY',
      );
    }
    return key;
  };
  const headerKey = normalize(params.headerKey, 'Header');
  const normalizedBodyKey = normalize(bodyKey, 'Request');
  if (headerKey && normalizedBodyKey && headerKey !== normalizedBodyKey) {
    throw new MediaTemplateError(
      'Idempotency-Key header and request body idempotency key must match.',
      400,
      'IDEMPOTENCY_KEY_MISMATCH',
    );
  }
  return headerKey ?? normalizedBodyKey;
}

function templateRunIdempotencyHash(params: {
  userId: string;
  templateId: string;
  isTest: boolean;
  key: string | null;
}) {
  if (!params.key) return null;
  return createHash('sha256')
    .update(`template-run-create:${params.userId}:${params.templateId}:${params.isTest ? 'test' : 'consumer'}:${params.key}`)
    .digest('hex');
}

async function loadIdempotentTemplateRun(params: {
  client: SupabaseClient;
  userId: string;
  templateId: string;
  isTest: boolean;
  clientRequestKeyHash: string | null;
}) {
  if (!params.clientRequestKeyHash) return null;
  const { data, error } = await params.client.from('template_runs')
    .select(RUN_SELECT)
    .eq('user_id', params.userId)
    .eq('template_id', params.templateId)
    .eq('is_test', params.isTest)
    .eq('client_request_key_hash', params.clientRequestKeyHash)
    .maybeSingle();
  if (error) throw error;
  const runId = isRecord(data) && typeof data.id === 'string' ? data.id : null;
  return runId ? loadRunState(params.client, runId, params.userId) : null;
}

export async function createTemplateRun(params: {
  client: SupabaseClient;
  templateId: string;
  userId: string;
  isTest?: boolean;
  body?: unknown;
  idempotencyKey?: string | null;
}): Promise<TemplateRunDto> {
  const isTest = Boolean(params.isTest);
  const requestKey = getTemplateRunIdempotencyKey({
    body: params.body,
    headerKey: params.idempotencyKey,
  });
  if (isTest) {
    const draft = await loadCompiledDraftForTemplate({
      client: params.client,
      templateId: params.templateId,
      userId: params.userId,
      body: params.body ?? {},
    });
    const snapshot = createSnapshot({
      compiled: draft.compiled,
      templateId: draft.template.id,
      templateVersionId: null,
      templateTitle: draft.template.name,
      sourceCanvasId: draft.canvas.id,
      sourceCanvasRevision: draft.canvas.revision,
    });
    const clientRequestKeyHash = templateRunIdempotencyHash({
      userId: params.userId,
      templateId: draft.template.id,
      isTest: true,
      key: requestKey,
    });
    const replay = await loadIdempotentTemplateRun({
      client: params.client,
      userId: params.userId,
      templateId: draft.template.id,
      isTest: true,
      clientRequestKeyHash,
    });
    if (replay) return toRunDto(params.client, replay);
    return toRunDto(params.client, await insertRunWithSteps({
      client: params.client,
      templateId: draft.template.id,
      templateVersionId: null,
      userId: params.userId,
      snapshot,
      isTest: true,
      clientRequestKeyHash,
    }));
  }

  const template = await loadMediaTemplateRow(params.client, params.templateId);
  if (!template || template.status !== 'active' || template.is_active !== true || !template.active_version_id) {
    throw new MediaTemplateError('Template not found.', 404, 'TEMPLATE_NOT_FOUND');
  }
  const { data: version, error } = await params.client.from('template_versions')
    .select('id, template_id, graph_snapshot').eq('id', template.active_version_id)
    .eq('template_id', template.id).maybeSingle();
  if (error) throw error;
  if (!version || !isRecord(version.graph_snapshot)) {
    throw new MediaTemplateError('Template version not found.', 404, 'TEMPLATE_VERSION_NOT_FOUND');
  }
  const snapshot = version.graph_snapshot as unknown as TemplateVersionSnapshot;
  const clientRequestKeyHash = templateRunIdempotencyHash({
    userId: params.userId,
    templateId: template.id,
    isTest: false,
    key: requestKey,
  });
  const replay = await loadIdempotentTemplateRun({
    client: params.client,
    userId: params.userId,
    templateId: template.id,
    isTest: false,
    clientRequestKeyHash,
  });
  if (replay) return toRunDto(params.client, replay);
  return toRunDto(params.client, await insertRunWithSteps({
    client: params.client,
    templateId: template.id,
    templateVersionId: version.id,
    userId: params.userId,
    snapshot,
    isTest: false,
    clientRequestKeyHash,
  }));
}

function sanitizeUploadFileName(value: unknown, kind: TemplateMediaKind, mimeType: string) {
  const fallbackExtension = kind === 'image'
    ? mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg'
    : mimeType === 'video/webm' ? '.webm' : mimeType === 'video/quicktime' ? '.mov' : '.mp4';
  const raw = typeof value === 'string' ? value : 'input';
  const rawExtension = path.extname(raw).toLowerCase();
  const allowedExtensions = getTemplateInputExtensions(kind);
  const extension = allowedExtensions.includes(rawExtension) ? rawExtension : fallbackExtension;
  const stem = path.basename(raw, rawExtension).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'input';
  return `${stem}${extension}`;
}

export async function createTemplateInputUploadIntent(params: {
  body: unknown;
  client: SupabaseClient;
  runId: string;
  userId: string;
}) {
  const run = await loadOwnedRun(params.client, params.runId, params.userId);
  if (run.status !== 'collecting_inputs') {
    throw new MediaTemplateError('Inputs can no longer be changed for this run.', 409, 'RUN_ALREADY_STARTED');
  }
  const input = isRecord(params.body) ? params.body : {};
  const slotKey = typeof input.slotKey === 'string' ? input.slotKey.trim() : '';
  const slot = asInputSlots(run.input_manifest).find((candidate) => candidate.key === slotKey);
  if (!slot) throw new MediaTemplateError('Unknown template input.', 400, 'INVALID_INPUT_SLOT');
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';
  const sizeBytes = Number(input.sizeBytes);
  validateTemplateInputDescriptor({ kind: slot.kind, mimeType, sizeBytes });
  const fileName = sanitizeUploadFileName(input.fileName, slot.kind, mimeType);
  const objectPath = `${params.userId}/${run.id}/staging/${slot.key}/${randomUUID()}-${fileName}`;
  const { data, error } = await params.client.storage.from(TEMPLATE_INPUT_BUCKET).createSignedUploadUrl(objectPath);
  if (error || !data?.token) {
    throw new MediaTemplateError('Failed to prepare the template input upload.', 500, 'UPLOAD_SIGN_FAILED');
  }
  return {
    success: true,
    bucket: TEMPLATE_INPUT_BUCKET,
    path: objectPath,
    storagePath: `${TEMPLATE_INPUT_BUCKET}/${objectPath}`,
    token: data.token,
    signedUploadUrl: data.signedUrl ?? null,
    expiresInSeconds: 2 * 60 * 60,
  };
}

function templateInputObjectPath(value: string) {
  return value.startsWith(`${TEMPLATE_INPUT_BUCKET}/`)
    ? value.slice(`${TEMPLATE_INPUT_BUCKET}/`.length)
    : '';
}

export async function finalizeTemplateRunInputs(params: {
  body: unknown;
  client: SupabaseClient;
  runId: string;
  userId: string;
}): Promise<TemplateRunDto> {
  const state = await loadRunState(params.client, params.runId, params.userId);
  if (state.run.status !== 'collecting_inputs') {
    throw new MediaTemplateError('Inputs can no longer be changed for this run.', 409, 'RUN_ALREADY_STARTED');
  }
  const candidates = isRecord(params.body) && Array.isArray(params.body.inputs) ? params.body.inputs : [];
  const submitted = new Map<string, string>();
  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.slotKey === 'string' && typeof candidate.storagePath === 'string') {
      submitted.set(candidate.slotKey, candidate.storagePath);
    }
  }
  const slots = asInputSlots(state.run.input_manifest);
  const existing = asStoragePaths(state.run.input_storage_paths);
  const finalized = { ...existing };
  const newFinalPaths: string[] = [];
  const stagingPaths: string[] = [];
  const replacedFinalPaths: string[] = [];
  try {
    for (const slot of slots) {
      const submittedPath = submitted.get(slot.key);
      if (!submittedPath) {
        if (!finalized[slot.key]) {
          throw new MediaTemplateError(`Upload ${slot.label} before continuing.`, 400, 'MISSING_TEMPLATE_INPUT');
        }
        continue;
      }
      const objectPath = templateInputObjectPath(submittedPath);
      const expectedPrefix = `${params.userId}/${state.run.id}/staging/${slot.key}/`;
      if (!objectPath.startsWith(expectedPrefix) || objectPath.includes('..') || objectPath.includes('\\')) {
        throw new MediaTemplateError(`Upload ${slot.label} before continuing.`, 400, 'INVALID_TEMPLATE_INPUT_PATH');
      }
      const { data: blob, error: downloadError } = await params.client.storage.from(TEMPLATE_INPUT_BUCKET).download(objectPath);
      if (downloadError || !blob) {
        throw new MediaTemplateError(`${slot.label} could not be verified.`, 400, 'INVALID_INPUT_FILE');
      }
      await validateTemplateInputBlob({ blob, objectPath, slot });
      const fileName = path.posix.basename(objectPath).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'input.bin';
      const finalObjectPath = `${params.userId}/${state.run.id}/final/${slot.key}/${randomUUID()}-${fileName}`;
      const { error: uploadError } = await params.client.storage.from(TEMPLATE_INPUT_BUCKET)
        .upload(finalObjectPath, blob, { contentType: blob.type || undefined, upsert: false });
      if (uploadError) throw new MediaTemplateError('Failed to finalize a template input.', 500, 'INPUT_FINALIZE_FAILED');
      newFinalPaths.push(finalObjectPath);
      stagingPaths.push(objectPath);
      if (finalized[slot.key]) replacedFinalPaths.push(templateInputObjectPath(finalized[slot.key]));
      finalized[slot.key] = `${TEMPLATE_INPUT_BUCKET}/${finalObjectPath}`;
    }
    for (const key of submitted.keys()) {
      if (!slots.some((slot) => slot.key === key)) {
        throw new MediaTemplateError('Unknown template input.', 400, 'INVALID_INPUT_SLOT');
      }
    }
    const { error: updateError } = await params.client.from('template_runs')
      .update({ input_storage_paths: finalized, error_message: null })
      .eq('id', state.run.id).eq('user_id', params.userId).eq('status', 'collecting_inputs');
    if (updateError) throw updateError;
  } catch (error) {
    if (newFinalPaths.length) await params.client.storage.from(TEMPLATE_INPUT_BUCKET).remove(newFinalPaths);
    throw error;
  }
  const removePaths = [...stagingPaths, ...replacedFinalPaths.filter(Boolean)];
  if (removePaths.length) {
    const { error } = await params.client.storage.from(TEMPLATE_INPUT_BUCKET).remove(removePaths);
    if (error) logBackendError('failed_to_remove_replaced_template_input_objects', { error: error });
  }
  return toRunDto(params.client, await loadRunState(params.client, state.run.id, params.userId));
}

function topologicalNodes(graph: WorkflowCanvasGraph): WorkflowCanvasNode[] {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }
  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const result: WorkflowCanvasNode[] = [];
  while (queue.length) {
    const nodeId = queue.shift()!;
    const node = getNodeById(graph, nodeId);
    if (node) result.push(node);
    for (const target of outgoing.get(nodeId) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  return result.length === graph.nodes.length ? result : graph.nodes;
}

async function hydrateRunGraph(client: SupabaseClient, state: RunState) {
  let graph = normalizeWorkflowGraph(state.snapshot.graph as Partial<WorkflowCanvasGraph>);
  const inputs = asStoragePaths(state.run.input_storage_paths);
  const signedCache = new Map<string, string>();
  const sign = async (value: string | null) => {
    if (!value) return null;
    if (!signedCache.has(value)) signedCache.set(value, await resolveStoredMediaUrl(client, value));
    return signedCache.get(value)!;
  };
  graph = {
    ...graph,
    nodes: await Promise.all(graph.nodes.map(async (node) => {
      if (node.type !== 'image-input' && node.type !== 'video-input') return node;
      const data = node.data as ImageInputNodeData | VideoInputNodeData;
      const storagePath = data.templateInput.mode === 'consumer'
        ? inputs[data.templateInput.key] ?? null
        : data.storagePath;
      const signedUrl = await sign(storagePath);
      if (node.type === 'image-input') {
        return { ...node, data: { ...data, storagePath, imageUrl: signedUrl } as ImageInputNodeData };
      }
      return { ...node, data: { ...data, storagePath, videoUrl: signedUrl } as VideoInputNodeData };
    })),
  };
  for (const step of state.latestSteps.values()) {
    const outputUrl = step.status === 'succeeded' ? await sign(step.output_url) : null;
    graph = updateNodeRunState(graph, step.node_id, {
      status: step.status === 'cancelled' ? 'failed' : step.status,
      generationId: step.generation_id,
      outputUrl,
      error: step.error_message,
      cost: step.estimated_credits,
      updatedAt: step.finished_at ?? step.started_at,
    });
  }
  return graph;
}

function generationIdempotencyHash(runId: string, nodeId: string, attempt: number) {
  return createHash('sha256').update(`template-run:${runId}:${nodeId}:${attempt}`).digest('hex');
}

function rawSourceOutput(state: RunState, graph: WorkflowCanvasGraph, sourceNode: WorkflowCanvasNode) {
  const sourceStep = state.latestSteps.get(sourceNode.id);
  if (sourceStep?.status === 'succeeded' && sourceStep.output_url) return sourceStep.output_url;
  if (sourceNode.type === 'image-input') return (sourceNode.data as ImageInputNodeData).storagePath;
  if (sourceNode.type === 'video-input') return (sourceNode.data as VideoInputNodeData).storagePath;
  return null;
}

async function refreshGenerationSteps(client: SupabaseClient, state: RunState) {
  const updates: PromiseLike<unknown>[] = [];
  for (const step of state.latestSteps.values()) {
    if (step.kind !== 'generation' || !step.generation_id || step.status !== 'processing') continue;
    const generation = state.generations.get(step.generation_id);
    if (!generation) continue;
    if (generation.status === 'succeeded' && generation.output_url) {
      updates.push(client.from('template_run_steps').update({
        status: 'succeeded',
        output_url: generation.output_url,
        error_message: null,
        output_snapshot: { cost: Math.max(0, generation.actual_cost ?? generation.cost ?? step.estimated_credits) },
        finished_at: generation.completed_at ?? new Date().toISOString(),
      }).eq('id', step.id).eq('status', 'processing'));
    } else if (generation.status === 'failed') {
      const failure = getPublicGenerationStartFailure({
        message: generation.error_message || 'This generation could not be completed.',
      });
      updates.push(client.from('template_run_steps').update({
        status: 'failed',
        error_message: failure.message,
        output_snapshot: failureSnapshot(step, failure.code),
        finished_at: generation.completed_at ?? new Date().toISOString(),
      }).eq('id', step.id).eq('status', 'processing'));
    }
  }
  await Promise.all(updates);
}

/**
 * Resolve the generation that produced the public result without exposing or
 * trusting graph data from the client. Approval nodes are pass-through gates,
 * so walk their single upstream edge until the successful generation step is
 * reached. Any ambiguity fails closed.
 */
function resolveCanonicalResultGenerationId(
  state: RunState,
  resultUrl: string,
): string | null {
  const graph = normalizeWorkflowGraph(state.snapshot.graph as Partial<WorkflowCanvasGraph>);
  const visited = new Set<string>();
  let nodeId = state.run.output_node_id;

  while (!visited.has(nodeId)) {
    visited.add(nodeId);
    const node = getNodeById(graph, nodeId);
    const step = state.latestSteps.get(nodeId);
    if (!node || !step || step.status !== 'succeeded' || step.output_url !== resultUrl) {
      return null;
    }

    if (step.kind === 'generation') {
      if (!step.generation_id) return null;
      const generation = state.generations.get(step.generation_id);
      return generation
        && generation.status === 'succeeded'
        && generation.output_url === resultUrl
        && generation.template_run_id === state.run.id
        && generation.template_run_step_id === step.id
        ? generation.id
        : null;
    }

    if (!isApprovalGateNode(node)) return null;
    const incomingEdges = getIncomingEdges(graph, node.id);
    if (incomingEdges.length !== 1) return null;
    nodeId = incomingEdges[0]!.source;
  }

  return null;
}

async function updateRunProgress(client: SupabaseClient, state: RunState) {
  const latest = Array.from(state.latestSteps.values());
  const creditsUsed = generationCredits(state.generations.values());
  const remaining = latest.reduce((total, step) => (
    step.kind === 'generation' && (step.status === 'queued' || step.status === 'failed')
      ? total + Math.max(0, step.estimated_credits)
      : total
  ), 0);
  const outputStep = state.latestSteps.get(state.run.output_node_id);
  if (latest.length && latest.every((step) => step.status === 'succeeded') && outputStep?.output_url) {
    const resultGenerationId = resolveCanonicalResultGenerationId(state, outputStep.output_url);
    if (!resultGenerationId) {
      throw new MediaTemplateError(
        'The final template result could not be verified.',
        409,
        'INVALID_CANONICAL_RESULT',
      );
    }
    const { data, error } = await client.rpc('record_template_run_success', {
      p_run_id: state.run.id,
      p_result_url: outputStep.output_url,
      p_credits_used: creditsUsed,
      p_result_generation_id: resultGenerationId,
    });
    if (error) throw error;
    if (data !== true) {
      throw new MediaTemplateError(
        'The final template result could not be verified.',
        409,
        'INVALID_CANONICAL_RESULT',
      );
    }
    return;
  }
  const status: TemplateRunStatus = latest.some((step) => step.status === 'failed')
    ? 'needs_attention'
    : latest.some((step) => step.status === 'processing')
      ? 'processing'
      : latest.some((step) => step.status === 'awaiting_approval')
        ? 'awaiting_approval'
        : latest.some((step) => step.status === 'queued')
          ? 'queued'
          : state.run.status;
  const failedStep = latest.find((step) => step.status === 'failed');
  await client.from('template_runs').update({
    status,
    credits_used: creditsUsed,
    estimated_remaining_credits: remaining,
    error_message: status === 'needs_attention'
      ? failedStep?.error_message || 'A workflow step needs another try.'
      : null,
  }).eq('id', state.run.id).neq('status', 'cancelled');
}

async function advanceTemplateRun(client: SupabaseClient, runId: string, userId: string) {
  let state = await loadRunState(client, runId, userId);
  if (
    TERMINAL_RUN_STATUSES.has(state.run.status)
    || state.run.status === 'needs_attention'
    || state.run.status === 'collecting_inputs'
  ) return state;
  let graph = await hydrateRunGraph(client, state);
  for (const node of topologicalNodes(graph)) {
    const step = state.latestSteps.get(node.id);
    if (!step || step.status !== 'queued') continue;
    const dependency = inspectWorkflowNodeDependencies(graph, node);
    if (dependency.kind === 'queued') continue;
    if (dependency.kind === 'blocked') {
      const hasFailedUpstream = getIncomingEdges(graph, node.id).some((edge) => {
        const upstream = state.latestSteps.get(edge.source);
        return upstream?.status === 'failed' || upstream?.status === 'cancelled';
      });
      if (hasFailedUpstream) continue;
      await client.from('template_run_steps').update({
        status: 'failed',
        error_message: 'This step is missing a required workflow input.',
        finished_at: new Date().toISOString(),
      }).eq('id', step.id).eq('status', 'queued');
      graph = updateNodeRunState(graph, node.id, { status: 'failed', error: dependency.message });
      continue;
    }
    if (isApprovalGateNode(node)) {
      const sourceEdge = getIncomingEdges(graph, node.id)[0];
      const sourceNode = sourceEdge ? getNodeById(graph, sourceEdge.source) : null;
      const pendingOutput = sourceNode ? rawSourceOutput(state, graph, sourceNode) : null;
      if (!pendingOutput) continue;
      const approval = node.data as ApprovalGateNodeData;
      await client.from('template_run_steps').update({
        status: 'awaiting_approval',
        output_url: pendingOutput,
        output_snapshot: { mediaKind: approval.mediaKind, allowRetry: approval.allowRetry },
        started_at: new Date().toISOString(),
      }).eq('id', step.id).eq('status', 'queued');
      graph = updateNodeRunState(graph, node.id, { status: 'awaiting_approval' });
      continue;
    }
    try {
      const result = await executeWorkflowRunnableNode({
        supabase: client,
        userId,
        node,
        graph,
        catalogRevision: state.run.catalog_revision,
        clientRequestKeyHash: generationIdempotencyHash(state.run.id, node.id, step.attempt),
        persistInputMedia: false,
        privateRecipe: true,
        templateContext: { runId: state.run.id, stepId: step.id },
      });
      if (result.status === 'blocked') {
        await client.from('template_run_steps').update({
          status: 'failed',
          error_message: 'This step is missing a required workflow input.',
          finished_at: new Date().toISOString(),
        }).eq('id', step.id);
        graph = updateNodeRunState(graph, node.id, { status: 'failed' });
      } else {
        await client.from('template_run_steps').update({
          input_snapshot: result.input_snapshot,
          output_snapshot: result.output_snapshot,
          error_message: null,
        }).eq('id', step.id);
        graph = updateNodeRunState(graph, node.id, {
          status: result.status,
          generationId: result.generation_id,
        });
      }
    } catch (error) {
      const status = isRecord(error) && typeof error.status === 'number' ? error.status : 500;
      if (status !== 409) {
        const failure = getPublicGenerationStartFailure(error);
        await client.from('template_run_steps').update({
          status: 'failed',
          error_message: failure.message,
          output_snapshot: failureSnapshot(step, failure.code),
          finished_at: new Date().toISOString(),
        }).eq('id', step.id);
        graph = updateNodeRunState(graph, node.id, { status: 'failed' });
      }
    }
  }
  state = await loadRunState(client, runId, userId);
  await updateRunProgress(client, state);
  return loadRunState(client, runId, userId);
}

async function cleanupTemplateRunInputs(client: SupabaseClient, state: RunState) {
  if (state.run.inputs_deleted_at || !['succeeded', 'failed', 'cancelled'].includes(state.run.status)) return state;
  const paths = Object.values(asStoragePaths(state.run.input_storage_paths))
    .map(templateInputObjectPath).filter(Boolean);
  if (paths.length) {
    const { error } = await client.storage.from(TEMPLATE_INPUT_BUCKET).remove(paths);
    if (error) {
      logBackendError('failed_to_clean_up_template_inputs', { error: error });
      return state;
    }
  }
  await client.from('template_runs').update({
    input_storage_paths: {},
    inputs_deleted_at: new Date().toISOString(),
  }).eq('id', state.run.id);
  return loadRunState(client, state.run.id, state.run.user_id);
}

async function preflightStoredTemplateRunInputs(client: SupabaseClient, state: RunState) {
  const inputs = asStoragePaths(state.run.input_storage_paths);
  for (const slot of asInputSlots(state.run.input_manifest)) {
    const storagePath = inputs[slot.key];
    const objectPath = storagePath ? templateInputObjectPath(storagePath) : '';
    const expectedPrefix = `${state.run.user_id}/${state.run.id}/final/${slot.key}/`;
    if (!objectPath.startsWith(expectedPrefix)) {
      throw new MediaTemplateError(`Upload ${slot.label} before starting.`, 400, 'MISSING_TEMPLATE_INPUT');
    }
    const { data: blob, error } = await client.storage.from(TEMPLATE_INPUT_BUCKET).download(objectPath);
    if (error || !blob) {
      throw new MediaTemplateError(`${slot.label} could not be verified. Upload it again.`, 400, 'INVALID_INPUT_FILE');
    }
    await validateTemplateInputBlob({ blob, objectPath, slot });
  }
}

export async function startTemplateRun(params: {
  adminClient: SupabaseClient;
  runId: string;
  userId: string;
}): Promise<TemplateRunDto> {
  let state = await loadRunState(params.adminClient, params.runId, params.userId);
  if (state.run.status === 'collecting_inputs') {
    const inputs = asStoragePaths(state.run.input_storage_paths);
    const missing = asInputSlots(state.run.input_manifest).find((slot) => !inputs[slot.key]);
    if (missing) throw new MediaTemplateError(`Upload ${missing.label} before starting.`, 400, 'MISSING_TEMPLATE_INPUT');
    await preflightStoredTemplateRunInputs(params.adminClient, state);
    const { error } = await params.adminClient.from('template_runs').update({ status: 'queued', error_message: null })
      .eq('id', state.run.id).eq('user_id', params.userId).eq('status', 'collecting_inputs');
    if (error) throw error;
  } else if (!['queued', 'processing'].includes(state.run.status)) {
    return toRunDto(params.adminClient, state);
  }
  state = await advanceTemplateRun(params.adminClient, state.run.id, params.userId);
  return toRunDto(params.adminClient, state);
}

export async function syncTemplateRun(params: {
  adminClient: SupabaseClient;
  runId: string;
  userId: string;
  request?: Request;
  userClient?: SupabaseClient;
}): Promise<TemplateRunDto> {
  let state = await loadRunState(params.adminClient, params.runId, params.userId);
  const activeIds = Array.from(state.latestSteps.values()).flatMap((step) => {
    if (step.status !== 'processing' || !step.generation_id) return [];
    const generation = state.generations.get(step.generation_id);
    return generation && ACTIVE_GENERATION_STATUSES.has(generation.status) ? [generation.id] : [];
  });
  if (activeIds.length) {
    try {
      await syncGenerationStatuses({
        supabase: params.adminClient,
        creditSupabase: params.adminClient,
        generationIds: activeIds,
      });
    } catch (error) {
      logBackendError('failed_to_synchronize_template_generations', { error: error });
    }
  }
  state = await loadRunState(params.adminClient, params.runId, params.userId);
  await refreshGenerationSteps(params.adminClient, state);
  state = await advanceTemplateRun(params.adminClient, params.runId, params.userId);
  state = await cleanupTemplateRunInputs(params.adminClient, state);
  return toRunDto(params.adminClient, state);
}

async function loadOwnedStep(client: SupabaseClient, runId: string, stepId: string, userId: string) {
  const state = await loadRunState(client, runId, userId);
  const step = state.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new MediaTemplateError('Template run step not found.', 404, 'STEP_NOT_FOUND');
  if (state.latestSteps.get(step.node_id)?.id !== step.id) {
    throw new MediaTemplateError('This step has already been replaced by a newer attempt.', 409, 'STALE_STEP_ATTEMPT');
  }
  return { state, step };
}

export async function approveTemplateRunStep(params: {
  adminClient: SupabaseClient;
  runId: string;
  stepId: string;
  userId: string;
}): Promise<TemplateRunDto> {
  const { state, step } = await loadOwnedStep(params.adminClient, params.runId, params.stepId, params.userId);
  if (step.kind !== 'approval' || step.status !== 'awaiting_approval' || !step.output_url) {
    throw new MediaTemplateError('This checkpoint is not waiting for approval.', 409, 'APPROVAL_NOT_READY');
  }
  const approvedAt = new Date().toISOString();
  const { data, error } = await params.adminClient.from('template_run_steps').update({
    status: 'succeeded',
    approved_at: approvedAt,
    finished_at: approvedAt,
    error_message: null,
  }).eq('id', step.id).eq('status', 'awaiting_approval').select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new MediaTemplateError('This checkpoint was already handled.', 409, 'APPROVAL_ALREADY_HANDLED');
  await params.adminClient.from('template_runs').update({ status: 'processing', error_message: null })
    .eq('id', state.run.id).neq('status', 'cancelled');
  const next = await advanceTemplateRun(params.adminClient, state.run.id, params.userId);
  return toRunDto(params.adminClient, next);
}

async function insertRetryStep(client: SupabaseClient, step: TemplateRunStepRow) {
  const nextAttempt = step.attempt + 1;
  const { data, error } = await client.from('template_run_steps').insert({
    run_id: step.run_id,
    node_id: step.node_id,
    attempt: nextAttempt,
    kind: step.kind,
    media_kind: step.media_kind,
    label: step.label,
    status: 'queued',
    can_retry: step.can_retry,
    estimated_credits: step.estimated_credits,
  }).select(STEP_SELECT).single();
  if (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    if (code !== '23505') throw error;
    const { data: existing, error: existingError } = await client.from('template_run_steps')
      .select(STEP_SELECT)
      .eq('run_id', step.run_id)
      .eq('node_id', step.node_id)
      .eq('attempt', nextAttempt)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) throw error;
    return existing as unknown as TemplateRunStepRow;
  }
  return data as unknown as TemplateRunStepRow;
}

export async function retryTemplateRunStep(params: {
  adminClient: SupabaseClient;
  runId: string;
  stepId: string;
  userId: string;
}): Promise<TemplateRunDto> {
  const state = await loadRunState(params.adminClient, params.runId, params.userId);
  if (TERMINAL_RUN_STATUSES.has(state.run.status)) {
    throw new MediaTemplateError(
      'This run has ended. Start a new run to try the template again.',
      409,
      'RUN_TERMINAL',
    );
  }
  const step = state.steps.find((candidate) => candidate.id === params.stepId);
  if (!step) throw new MediaTemplateError('Template run step not found.', 404, 'STEP_NOT_FOUND');
  const current = state.latestSteps.get(step.node_id);
  if (current?.id !== step.id) {
    if (current && current.attempt === step.attempt + 1) {
      return toRunDto(params.adminClient, state);
    }
    throw new MediaTemplateError(
      'This step has already been replaced by a newer attempt.',
      409,
      'STALE_STEP_ATTEMPT',
    );
  }
  if (!step.can_retry || !['failed', 'awaiting_approval'].includes(step.status)) {
    throw new MediaTemplateError('This step cannot be retried right now.', 409, 'STEP_NOT_RETRYABLE');
  }
  if (step.kind === 'generation') {
    if (step.status !== 'failed') throw new MediaTemplateError('This generation is still active.', 409, 'STEP_NOT_RETRYABLE');
    if (requiresReplacementGenerationInput({
      code: stepFailureCode(step),
      message: step.error_message,
    })) {
      throw new MediaTemplateError(
        'This upload cannot be reused. Start a new run with a replacement image.',
        409,
        'NEW_INPUT_REQUIRED',
      );
    }
    await insertRetryStep(params.adminClient, step);
  } else {
    const graph = normalizeWorkflowGraph(state.snapshot.graph as Partial<WorkflowCanvasGraph>);
    const gate = getNodeById(graph, step.node_id);
    const sourceEdge = gate ? getIncomingEdges(graph, gate.id)[0] : null;
    const sourceStep = sourceEdge ? state.latestSteps.get(sourceEdge.source) : null;
    if (!sourceStep || sourceStep.kind !== 'generation' || sourceStep.status !== 'succeeded') {
      throw new MediaTemplateError('The generation before this checkpoint cannot be retried.', 409, 'UPSTREAM_STEP_NOT_RETRYABLE');
    }
    const cancelledAt = new Date().toISOString();
    await params.adminClient.from('template_run_steps').update({
      status: 'cancelled',
      finished_at: cancelledAt,
    }).eq('id', step.id).eq('status', 'awaiting_approval');
    await insertRetryStep(params.adminClient, sourceStep);
    await insertRetryStep(params.adminClient, step);
  }
  await params.adminClient.from('template_runs').update({ status: 'queued', error_message: null })
    .eq('id', state.run.id).in('status', ['awaiting_approval', 'needs_attention']);
  const next = await advanceTemplateRun(params.adminClient, state.run.id, params.userId);
  return toRunDto(params.adminClient, next);
}

export async function cancelTemplateRun(client: SupabaseClient, runId: string, userId: string): Promise<TemplateRunDto> {
  const state = await loadRunState(client, runId, userId);
  if (!TERMINAL_RUN_STATUSES.has(state.run.status)) {
    const now = new Date().toISOString();
    await client.from('template_runs').update({
      status: 'cancelled',
      completed_at: now,
      error_message: null,
    }).eq('id', state.run.id).eq('user_id', userId);
    await client.from('template_run_steps').update({
      status: 'cancelled',
      finished_at: now,
    }).eq('run_id', state.run.id).in('status', ['queued', 'processing', 'awaiting_approval']);
  }
  const cancelledState = await loadRunState(client, runId, userId);
  return toRunDto(client, await cleanupTemplateRunInputs(client, cancelledState));
}
