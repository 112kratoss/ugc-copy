import { normalizeGenerationStartFailureCode } from '@/lib/generation-public-failure';

import type {
  MediaTemplate,
  TemplateCreator,
  TemplateInputSlot,
  TemplateMediaKind,
  TemplateRun,
  TemplateRunStatus,
  TemplateRunStep,
} from './types';

type ApiOptions = Omit<RequestInit, 'body'> & {
  token?: string | null;
  body?: unknown;
};

type UnknownRecord = Record<string, unknown>;

export class TemplateApiError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'TemplateApiError';
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: string;
    code?: string;
  } & T;

  if (!response.ok) {
    throw new TemplateApiError(
      payload.error || 'The request could not be completed.',
      response.status,
      payload.code ?? null
    );
  }
  return payload;
}

function idempotencyHeaders(idempotencyKey?: string): HeadersInit | undefined {
  return idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function first(record: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function stringValue(record: UnknownRecord, keys: string[], fallback = ''): string {
  const value = first(record, keys);
  return typeof value === 'string' ? value : fallback;
}

function nullableString(record: UnknownRecord, keys: string[]): string | null {
  const value = first(record, keys);
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(record: UnknownRecord, keys: string[]): number | null {
  const value = first(record, keys);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(record: UnknownRecord, keys: string[], fallback: boolean): boolean {
  const value = first(record, keys);
  return typeof value === 'boolean' ? value : fallback;
}

function mediaKind(value: unknown, fallback: TemplateMediaKind = 'image'): TemplateMediaKind {
  return value === 'video' ? 'video' : value === 'image' ? 'image' : fallback;
}

function normalizeSlot(value: unknown, index: number): TemplateInputSlot {
  const slot = asRecord(value);
  return {
    key: stringValue(slot, ['key', 'slotKey', 'slot_key'], `input_${index + 1}`),
    kind: mediaKind(first(slot, ['kind', 'mediaKind', 'media_kind'])),
    label: stringValue(slot, ['label', 'name'], `Input ${index + 1}`),
    description: nullableString(slot, ['description', 'instructions', 'helpText', 'help_text']) ?? undefined,
    required: booleanValue(slot, ['required'], true),
  };
}

function normalizeSlots(value: unknown): TemplateInputSlot[] {
  return Array.isArray(value) ? value.map(normalizeSlot) : [];
}

function normalizeCreator(value: unknown, parent: UnknownRecord): TemplateCreator | null {
  const creator = asRecord(value);
  const id = stringValue(creator, ['id'], stringValue(parent, ['creatorUserId', 'creator_user_id']));
  const username = nullableString(creator, ['username']);
  const displayName = nullableString(creator, ['displayName', 'display_name']);
  const avatarUrl = nullableString(creator, ['avatarUrl', 'avatar_url']);
  return id || username || displayName || avatarUrl ? { id, username, displayName, avatarUrl } : null;
}

export function normalizeTemplate(value: unknown): MediaTemplate {
  const wrapper = asRecord(value);
  const template = asRecord(wrapper.template ?? wrapper.data ?? value);
  const legacyCredits = asRecord(first(template, ['estimatedStageCredits', 'estimated_stage_credits']));
  const legacyTotal = numberValue(legacyCredits, ['total']);
  const legacyFrameCredits = numberValue(template, ['estimatedFrameCredits', 'estimated_frame_credits'])
    ?? numberValue(legacyCredits, ['keyframesTotal', 'keyframes_total']);
  const legacyVideoCredits = numberValue(template, ['estimatedVideoCredits', 'estimated_video_credits'])
    ?? numberValue(legacyCredits, ['video']);

  return {
    id: stringValue(template, ['id']),
    slug: stringValue(template, ['slug'], stringValue(template, ['id'])),
    name: stringValue(template, ['name', 'title'], 'Untitled template'),
    description: nullableString(template, ['description']),
    category: stringValue(template, ['category'], 'Creative'),
    videoUrl: nullableString(template, ['videoUrl', 'video_url', 'demoVideoUrl', 'demo_video_url']),
    thumbnailUrl: nullableString(template, ['thumbnailUrl', 'thumbnail_url']),
    creatorUserId: nullableString(template, ['creatorUserId', 'creator_user_id']),
    creator: normalizeCreator(template.creator, template),
    inputSlots: normalizeSlots(first(template, ['inputSlots', 'input_slots'])),
    outputKind: mediaKind(first(template, ['outputKind', 'output_kind']), 'video'),
    status: ['draft', 'active', 'disabled'].includes(stringValue(template, ['status']))
      ? stringValue(template, ['status']) as MediaTemplate['status']
      : 'active',
    useCount: numberValue(template, ['useCount', 'use_count']) ?? 0,
    estimatedTotalCredits: numberValue(template, ['estimatedTotalCredits', 'estimated_total_credits'])
      ?? legacyTotal
      ?? (legacyFrameCredits !== null || legacyVideoCredits !== null
        ? (legacyFrameCredits ?? 0) + (legacyVideoCredits ?? 0)
        : null),
    createdAt: stringValue(template, ['createdAt', 'created_at']),
    updatedAt: stringValue(template, ['updatedAt', 'updated_at']),
  };
}

function normalizeRunStatus(value: unknown): TemplateRunStatus {
  if (value === 'generating_keyframes' || value === 'generating_frames' || value === 'generating_video') return 'processing';
  if (value === 'awaiting_frame_approval') return 'awaiting_approval';
  if (
    value === 'collecting_inputs'
    || value === 'queued'
    || value === 'processing'
    || value === 'running'
    || value === 'awaiting_approval'
    || value === 'needs_attention'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'cancelled'
  ) return value;
  return 'needs_attention';
}

function normalizeStep(value: unknown, index: number): TemplateRunStep | null {
  const step = asRecord(value);
  const id = stringValue(step, ['id', 'stepId', 'step_id']);
  if (!id) return null;
  const kind = stringValue(step, ['kind', 'stepKind', 'step_kind']) === 'approval' ? 'approval' : 'generation';
  return {
    id,
    kind,
    mediaKind: mediaKind(first(step, ['mediaKind', 'media_kind', 'outputKind', 'output_kind'])),
    status: stringValue(step, ['status'], 'queued'),
    label: stringValue(step, ['label', 'name'], `${kind === 'approval' ? 'Review' : 'Generation'} ${index + 1}`),
    outputUrl: nullableString(step, ['outputUrl', 'output_url']),
    errorMessage: nullableString(step, ['errorMessage', 'error_message', 'error']),
    failureCode: normalizeGenerationStartFailureCode(first(step, ['failureCode', 'failure_code', 'errorCode', 'error_code'])),
    canRetry: booleanValue(step, ['canRetry', 'can_retry'], false),
    estimatedRetryCredits: numberValue(step, ['estimatedRetryCredits', 'estimated_retry_credits']),
  };
}

function normalizeLegacyGeneration(value: unknown, label: string, media: TemplateMediaKind): TemplateRunStep | null {
  const generation = asRecord(value);
  const id = stringValue(generation, ['id']);
  if (!id) return null;
  const status = stringValue(generation, ['status'], 'queued');
  return {
    id,
    kind: 'generation',
    mediaKind: media,
    status,
    label,
    outputUrl: nullableString(generation, ['outputUrl', 'output_url']),
    errorMessage: nullableString(generation, ['errorMessage', 'error_message', 'error']),
    failureCode: normalizeGenerationStartFailureCode(first(generation, ['failureCode', 'failure_code', 'errorCode', 'error_code'])),
    canRetry: ['failed', 'error', 'succeeded', 'completed', 'success'].includes(status.toLowerCase()),
    estimatedRetryCredits: numberValue(generation, ['estimatedRetryCredits', 'estimated_retry_credits', 'cost']),
  };
}

function normalizeSteps(run: UnknownRecord): TemplateRunStep[] {
  const publicSteps = first(run, ['steps', 'runSteps', 'run_steps']);
  if (Array.isArray(publicSteps)) {
    return publicSteps.map(normalizeStep).filter((step): step is TemplateRunStep => Boolean(step));
  }
  return [
    normalizeLegacyGeneration(first(run, ['startFrameGeneration', 'start_frame_generation']), 'Starting frame', 'image'),
    normalizeLegacyGeneration(first(run, ['finalFrameGeneration', 'final_frame_generation']), 'Final frame', 'image'),
    normalizeLegacyGeneration(first(run, ['videoGeneration', 'video_generation']), 'Final video', 'video'),
  ].filter((step): step is TemplateRunStep => Boolean(step));
}

function normalizeInputs(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((item, index) => {
      const input = asRecord(item);
      const key = stringValue(input, ['slotKey', 'slot_key', 'key'], `input_${index + 1}`);
      const path = stringValue(input, ['storagePath', 'storage_path', 'previewUrl', 'preview_url'], key);
      return key ? [[key, path]] : [];
    }));
  }
  return Object.fromEntries(Object.entries(asRecord(value)).map(([key, rawValue]) => {
    if (typeof rawValue === 'string') return [key, rawValue];
    const input = asRecord(rawValue);
    return [key, stringValue(input, ['storagePath', 'storage_path', 'previewUrl', 'preview_url'], key)];
  }));
}

export function normalizeTemplateRun(value: unknown): TemplateRun {
  const wrapper = asRecord(value);
  const run = asRecord(wrapper.run ?? wrapper.data ?? value);
  const snapshot = asRecord(first(run, ['templateSnapshot', 'template_snapshot']));
  const template = asRecord(run.template);
  const steps = normalizeSteps(run);
  const resultRecord = asRecord(run.result);
  const canonicalResultUrl = nullableString(resultRecord, ['url', 'outputUrl', 'output_url']);
  const legacyVideo = asRecord(first(run, ['videoGeneration', 'video_generation']));
  const legacyVideoUrl = nullableString(legacyVideo, ['outputUrl', 'output_url']);
  const legacyStatus = stringValue(legacyVideo, ['status']).toLowerCase();
  const resultUrl = canonicalResultUrl
    ?? (['succeeded', 'completed', 'success'].includes(legacyStatus) ? legacyVideoUrl : null);

  return {
    id: stringValue(run, ['id']),
    templateId: stringValue(run, ['templateId', 'template_id'], stringValue(template, ['id'])),
    templateTitle: stringValue(run, ['templateTitle', 'template_title'], stringValue(template, ['name', 'title'], 'Template creation')),
    userId: stringValue(run, ['userId', 'user_id']),
    status: normalizeRunStatus(run.status),
    inputSlots: normalizeSlots(
      first(run, ['inputSlots', 'input_slots'])
      ?? first(snapshot, ['inputSlots', 'input_slots'])
      ?? first(template, ['inputSlots', 'input_slots'])
    ),
    inputs: normalizeInputs(first(run, ['inputs', 'runInputs', 'run_inputs'])),
    steps,
    result: resultUrl ? {
      generationId: stringValue(resultRecord, ['generationId', 'generation_id']),
      kind: mediaKind(first(resultRecord, ['kind', 'mediaKind', 'media_kind']), legacyVideoUrl ? 'video' : 'image'),
      url: resultUrl,
    } : null,
    estimatedTotalCredits: numberValue(run, ['estimatedTotalCredits', 'estimated_total_credits']),
    estimatedRemainingCredits: numberValue(run, ['estimatedRemainingCredits', 'estimated_remaining_credits'])
      ?? numberValue(run, ['estimatedVideoCredits', 'estimated_video_credits']),
    creditsUsed: numberValue(run, ['creditsUsed', 'credits_used']) ?? 0,
    errorMessage: nullableString(run, ['errorMessage', 'error_message', 'error']),
    isTest: booleanValue(run, ['isTest', 'is_test'], false),
    createdAt: stringValue(run, ['createdAt', 'created_at']),
    updatedAt: stringValue(run, ['updatedAt', 'updated_at']),
  };
}

export async function listTemplates(options: { token?: string | null; mine?: boolean } = {}): Promise<MediaTemplate[]> {
  const suffix = options.mine ? '?mine=1' : '';
  const payload = await requestJson<unknown>(`/api/templates${suffix}`, { token: options.token });
  const response = asRecord(payload);
  const templates = first(response, ['templates', 'items', 'data']);
  return Array.isArray(templates) ? templates.map(normalizeTemplate) : [];
}

export async function listTemplatePage(options: {
  token?: string | null;
  cursor?: string | null;
  limit?: number;
} = {}): Promise<{ templates: MediaTemplate[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  const suffix = params.size ? `?${params}` : '';
  const payload = asRecord(await requestJson<unknown>(`/api/templates${suffix}`, { token: options.token }));
  const templates = first(payload, ['templates', 'items', 'data']);
  return {
    templates: Array.isArray(templates) ? templates.map(normalizeTemplate) : [],
    nextCursor: nullableString(payload, ['nextCursor', 'next_cursor']),
  };
}

export async function getTemplate(idOrSlug: string, token?: string | null): Promise<MediaTemplate> {
  return normalizeTemplate(await requestJson<unknown>(
    `/api/templates/${encodeURIComponent(idOrSlug)}`,
    { token }
  ));
}

export async function createTemplateRun(templateId: string, token: string, idempotencyKey?: string): Promise<TemplateRun> {
  return normalizeTemplateRun(await requestJson<unknown>(
    `/api/templates/${encodeURIComponent(templateId)}/runs`,
    { method: 'POST', token, headers: idempotencyHeaders(idempotencyKey) }
  ));
}

export async function getTemplateRun(runId: string, token: string): Promise<TemplateRun> {
  return normalizeTemplateRun(await requestJson<unknown>(
    `/api/template-runs/${encodeURIComponent(runId)}`,
    { token }
  ));
}

export type TemplateInputUploadIntent = {
  bucket: 'template_inputs';
  path: string;
  storagePath: string;
  token: string;
  signedUploadUrl: string | null;
  expiresInSeconds: number;
};

export async function signTemplateInput(options: {
  runId: string;
  token: string;
  slotKey: string;
  file: File;
}): Promise<TemplateInputUploadIntent> {
  return requestJson<TemplateInputUploadIntent>(
    `/api/template-runs/${encodeURIComponent(options.runId)}/inputs/sign`,
    {
      method: 'POST',
      token: options.token,
      body: {
        slotKey: options.slotKey,
        fileName: options.file.name || options.slotKey,
        mimeType: options.file.type || 'application/octet-stream',
        sizeBytes: options.file.size,
      },
    }
  );
}

export async function finalizeTemplateInputs(options: {
  runId: string;
  token: string;
  inputs: Array<{ slotKey: string; storagePath: string }>;
}): Promise<TemplateRun> {
  return normalizeTemplateRun(await requestJson<unknown>(
    `/api/template-runs/${encodeURIComponent(options.runId)}/inputs/finalize`,
    { method: 'POST', token: options.token, body: { inputs: options.inputs } }
  ));
}

export async function startTemplateRun(runId: string, token: string, idempotencyKey?: string): Promise<TemplateRun> {
  return normalizeTemplateRun(await requestJson<unknown>(
    `/api/template-runs/${encodeURIComponent(runId)}/start`,
    { method: 'POST', token, headers: idempotencyHeaders(idempotencyKey) }
  ));
}

export async function retryTemplateRunStep(options: {
  runId: string;
  stepId: string;
  token: string;
  idempotencyKey?: string;
}): Promise<TemplateRun> {
  return normalizeTemplateRun(await requestJson<unknown>(
    `/api/template-runs/${encodeURIComponent(options.runId)}/steps/${encodeURIComponent(options.stepId)}/retry`,
    { method: 'POST', token: options.token, headers: idempotencyHeaders(options.idempotencyKey) }
  ));
}

export async function approveTemplateRunStep(options: {
  runId: string;
  stepId: string;
  token: string;
  idempotencyKey?: string;
}): Promise<TemplateRun> {
  return normalizeTemplateRun(await requestJson<unknown>(
    `/api/template-runs/${encodeURIComponent(options.runId)}/approval-steps/${encodeURIComponent(options.stepId)}/approve`,
    { method: 'POST', token: options.token, headers: idempotencyHeaders(options.idempotencyKey) }
  ));
}

export async function cancelTemplateRun(runId: string, token: string): Promise<TemplateRun> {
  return normalizeTemplateRun(await requestJson<unknown>(
    `/api/template-runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST', token }
  ));
}

export function createClientIdempotencyKey(scope: string): string {
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${scope}:${randomId}`;
}
