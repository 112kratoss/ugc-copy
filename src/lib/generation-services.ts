import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildElementHandle,
  compileImagePromptWithElements,
  compilePromptWithElements,
  findUnknownPromptHandles,
  isValidElementHandle,
  normalizeElementDisplayName,
  normalizeSubmittedElementDescriptors,
  type ImageElementDescriptor,
} from '@/lib/image-elements';
import {
  getImageCost,
  getImageResolutionOptions,
  getMotionCost,
  getSoundEffectCost,
  getVideoCost,
  getVideoElementSupport,
  isValidImageResolution,
  isValidImageQualityMode,
  isValidVideoDuration,
  getVoiceoverCost,
  IMAGE_MODELS,
  MOTION_MODELS,
  SOUND_EFFECT_MODELS,
  VIDEO_MODELS,
  VOICEOVER_MODELS,
  isAudioModel,
  isImageModel,
  type ImageOutputFormat,
  type ImageModelId,
  type ImageQualityMode,
  type ImageResolution,
  type MotionModelId,
  type SoundEffectModelId,
  type VideoModelId,
  type VoiceoverModelId,
} from '@/lib/models';
import { normalizeRemixMediaAssetDescriptor, type RemixMediaAssetDescriptor } from '@/lib/remix-source';
import {
  hasSeedanceAssetCollections,
  isSeedance2VideoModelId,
  type SeedanceAssetCollections,
} from '@/lib/seedance-assets';
import {
  getGenerationKind,
  normalizeMarketGenerationTiming,
  normalizeVeoGenerationTiming,
  toIsoTimestamp,
} from '@/lib/generation-timing';
import {
  collectImageInputCandidates,
  collectSeedanceAssetCandidates,
  persistGenerationInputMedia,
  type PersistGenerationInputCandidate,
} from '@/lib/generation-input-media';
import {
  createGenerationOutputPreview,
  isImageGenerationPreview,
} from '@/lib/generation-media-preview';
import { resolveStoredMediaUrl } from '@/lib/server-helpers';
import { buildKieWebhookCallbackUrl, extractKieWebhookTaskId } from '@/lib/kie-webhook';
import type { GenerationStartResult } from '@/lib/generation-start-idempotency';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;
const PROVIDER_TASK_ATTACH_ATTEMPTS = 3;

interface DialogueTurnInput {
  text: string;
  voice: string;
}

export interface VideoMultiPromptInput {
  id?: string;
  prompt: string;
  duration: number;
}

export interface ReferenceImageInput {
  url: string;
  handle?: string | null;
  displayName?: string;
  storagePath?: string | null;
  sourceGenerationId?: string | null;
}

export interface KlingVideoElementInput {
  id?: string | null;
  url: string;
  handle?: string | null;
  displayName?: string | null;
  storagePath?: string | null;
  sourceGenerationId?: string | null;
}

export class GenerationServiceError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'GenerationServiceError';
    this.status = status;
  }
}

export interface SyncableGenerationRecord {
  id: string;
  user_id: string;
  prediction_id: string | null;
  status: string;
  output_url: string | null;
  model: string;
  category: string | null;
  workflow_settings: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
}

export type GenerationSyncStatus = 'missing' | 'skipped' | 'waiting' | 'processing' | 'succeeded' | 'failed';
type GenerationTerminalSettlementStatus = 'succeeded' | 'failed';

export type GenerationStatusSyncResult =
  | { found: false; status: 'missing'; generation: null }
  | { found: true; status: Exclude<GenerationSyncStatus, 'missing'>; generation: SyncableGenerationRecord };

export interface PersistedGenerationOutput {
  index: number;
  storagePath: string;
}

export interface PersistedGenerationOutputListResult {
  status: GenerationTerminalSettlementStatus;
  outputs: PersistedGenerationOutput[];
}

function supabaseErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function requireApiKey(): string {
  if (!KIE_API_KEY) {
    throw new Error('Server configuration error: API key missing');
  }
  return KIE_API_KEY;
}

async function deductCreditsOrThrow(creditSupabase: SupabaseClient, userId: string, cost: number): Promise<number> {
  const { data: remainingCredits, error } = await creditSupabase.rpc('deduct_credits', {
    p_user_id: userId,
    p_cost: cost,
  });

  if (error) {
    throw new GenerationServiceError(error.message || 'Failed to verify credits', 500);
  }

  if (remainingCredits === -1) {
    throw new GenerationServiceError(`Insufficient credits. This action costs ${cost} credits.`, 402);
  }

  return remainingCredits;
}

function resolveQuotedGenerationCost(computedCost: number, quotedCostCredits?: number): number {
  if (quotedCostCredits === undefined) {
    return computedCost;
  }

  if (!Number.isInteger(quotedCostCredits) || quotedCostCredits < 0) {
    throw new GenerationServiceError('Invalid quoted generation cost.', 500);
  }

  return quotedCostCredits;
}

async function refundCreditsQuietly(creditSupabase: SupabaseClient, userId: string, amount: number) {
  try {
    await creditSupabase.rpc('refund_credits', { p_user_id: userId, p_amount: amount });
  } catch (error) {
    console.error('Failed to refund credits:', error);
  }
}

export async function settleGenerationFailed(
  creditSupabase: SupabaseClient,
  predictionId: string,
  completedAt?: string | null,
): Promise<'failed' | 'succeeded'> {
  const { data, error } = await creditSupabase.rpc('settle_generation_failed', {
    p_prediction_id: predictionId,
    p_completed_at: completedAt ?? null,
  });

  if (error || !isRecord(data)) {
    throw new GenerationServiceError(
      supabaseErrorMessage(error, 'Failed to settle failed generation.'),
      500,
    );
  }

  const status = typeof data.status === 'string' ? data.status : null;
  if (status === 'failed') return 'failed';
  if (status === 'already_succeeded') return 'succeeded';

  if (status === 'missing') {
    throw new GenerationServiceError('Generation not found for failure settlement.', 404);
  }

  if (status === 'invalid_request') {
    throw new GenerationServiceError('Invalid generation failure settlement request.', 400);
  }

  if (status === 'profile_not_found') {
    throw new GenerationServiceError('Could not find a credit profile for this account.', 500);
  }

  throw new GenerationServiceError('Failed to settle failed generation.', 500);
}

export async function settleGenerationSucceeded(
  settlementSupabase: SupabaseClient,
  params: {
    predictionId: string;
    outputUrl?: string | null;
    completedAt?: string | null;
    previewUrl?: string | null;
    previewThumbhash?: string | null;
    previewStatus?: 'pending' | 'ready' | 'failed' | string | null;
    previewAttemptCount?: number | null;
    previewError?: string | null;
    previewGeneratedAt?: string | null;
    workflowSettings?: Record<string, unknown> | null;
  },
): Promise<GenerationTerminalSettlementStatus> {
  const { data, error } = await settlementSupabase.rpc('settle_generation_succeeded', {
    p_prediction_id: params.predictionId,
    p_output_url: params.outputUrl ?? null,
    p_completed_at: params.completedAt ?? null,
    p_preview_url: params.previewUrl ?? null,
    p_preview_thumbhash: params.previewThumbhash ?? null,
    p_preview_status: params.previewStatus ?? null,
    p_preview_attempt_count: params.previewAttemptCount ?? null,
    p_preview_error: params.previewError ?? null,
    p_preview_generated_at: params.previewGeneratedAt ?? null,
    p_workflow_settings: params.workflowSettings ?? null,
  });

  if (error || !isRecord(data)) {
    throw new GenerationServiceError(
      supabaseErrorMessage(error, 'Failed to settle successful generation.'),
      500,
    );
  }

  const status = typeof data.status === 'string' ? data.status : null;
  if (status === 'succeeded' || status === 'already_succeeded') return 'succeeded';
  if (status === 'already_failed') return 'failed';

  if (status === 'missing') {
    throw new GenerationServiceError('Generation not found for success settlement.', 404);
  }

  if (status === 'invalid_request') {
    throw new GenerationServiceError('Invalid generation success settlement request.', 400);
  }

  throw new GenerationServiceError('Failed to settle successful generation.', 500);
}

async function createKieTask(
  body: Record<string, unknown>,
  endpoint = 'https://api.kie.ai/api/v1/jobs/createTask',
  options: { generationId?: string | null } = {},
) {
  requireApiKey();
  const callbackUrl = typeof body.callBackUrl === 'string' && body.callBackUrl.trim()
    ? body.callBackUrl
    : buildKieWebhookCallbackUrl({ generationId: options.generationId });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...body, callBackUrl: callbackUrl }),
  });

  const data = await response.json();
  if (!response.ok || data.code !== 200) {
    throw new Error(data.msg || 'Provider rejected the request');
  }

  return data.data.taskId as string;
}

async function reserveGenerationRecord(
  supabase: SupabaseClient,
  record: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await supabase
    .from('generations')
    .insert({
      ...record,
      prediction_id: null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) {
    throw new GenerationServiceError(
      supabaseErrorMessage(error, 'Failed to create generation record.'),
      500,
    );
  }

  const generationId = data?.id;
  if (typeof generationId !== 'string' || !generationId) {
    throw new GenerationServiceError('Failed to create generation record.', 500);
  }

  return generationId;
}

async function startGenerationRecord(
  supabase: SupabaseClient,
  record: Record<string, unknown>,
): Promise<{
  generationId: string;
  remainingCredits: number;
  cost: number;
  predictionId?: string;
  idempotentReplay?: boolean;
}> {
  const { data, error } = await supabase.rpc('start_generation', {
    p_user_id: record.user_id,
    p_cost: record.cost,
    p_model: record.model,
    p_prompt: record.prompt ?? null,
    p_category: record.category ?? null,
    p_duration: record.duration ?? null,
    p_creation_mode: record.creation_mode ?? null,
    p_source_generation_id: record.source_generation_id ?? null,
    p_workflow_settings: record.workflow_settings ?? null,
    p_client_request_key_hash: record.client_request_key_hash ?? null,
  });

  if (error || !isRecord(data)) {
    throw new GenerationServiceError(
      supabaseErrorMessage(error, 'Failed to start generation.'),
      500,
    );
  }

  const status = typeof data.status === 'string' ? data.status : null;
  const generationId = typeof data.generation_id === 'string' ? data.generation_id : null;
  const remainingCredits = typeof data.remaining_credits === 'number' ? data.remaining_credits : null;
  const cost = typeof data.cost === 'number' ? data.cost : Number(record.cost ?? 0);
  const predictionId = typeof data.prediction_id === 'string' ? data.prediction_id : null;

  if (status === 'insufficient_credits') {
    throw new GenerationServiceError(`Insufficient credits. This action costs ${cost} credits.`, 402);
  }

  if (status === 'invalid_cost' || status === 'invalid_request') {
    throw new GenerationServiceError('Invalid generation start request.', 400);
  }

  if (status === 'profile_not_found') {
    throw new GenerationServiceError('Could not find a credit profile for this account.', 401);
  }

  if (status === 'invalid_idempotency_key') {
    throw new GenerationServiceError('Generation idempotency key is invalid.', 400);
  }

  if (status === 'in_progress') {
    throw new GenerationServiceError(
      'A generation with this idempotency key is already starting. Retry shortly.',
      409,
    );
  }

  if (status === 'key_already_used') {
    throw new GenerationServiceError(
      'This idempotency key was already used by a failed generation start. Retry with a new key.',
      409,
    );
  }

  if (status === 'already_started') {
    if (!generationId || !predictionId || typeof remainingCredits !== 'number') {
      throw new GenerationServiceError('Failed to replay generation start.', 500);
    }

    return {
      generationId,
      predictionId,
      remainingCredits,
      cost,
      idempotentReplay: true,
    };
  }

  if (status !== 'started' || !generationId || typeof remainingCredits !== 'number') {
    throw new GenerationServiceError('Failed to start generation.', 500);
  }

  return {
    generationId,
    remainingCredits,
    cost,
  };
}

async function markGenerationProviderStarted(
  supabase: SupabaseClient,
  generationId: string,
  predictionId: string,
) {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= PROVIDER_TASK_ATTACH_ATTEMPTS; attempt += 1) {
    const { error } = await supabase
      .from('generations')
      .update({
        prediction_id: predictionId,
        status: 'processing',
      })
      .eq('id', generationId);

    if (!error) return;
    lastError = error;
  }

  console.error(JSON.stringify({
    level: 'error',
    msg: 'generation_provider_task_attach_failed',
    generationId,
    predictionId,
    attempts: PROVIDER_TASK_ATTACH_ATTEMPTS,
    error: supabaseErrorMessage(lastError, 'Failed to attach provider task to generation.'),
  }));
  throw new GenerationServiceError('Failed to attach provider task to generation.', 500);
}

async function markGenerationStartFailedQuietly(
  supabase: SupabaseClient,
  generationId: string | null,
) {
  if (!generationId) return;

  try {
    const { error } = await supabase
      .from('generations')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        client_request_key_hash: null,
      })
      .eq('id', generationId);

    if (error) {
      console.error('Failed to mark generation start failed:', error);
    }
  } catch (error) {
    console.error('Failed to mark generation start failed:', error);
  }
}

function trimPrompt(prompt: string, errorMessage: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new GenerationServiceError(errorMessage, 400);
  }

  return trimmed;
}

function assertGenerationRequest(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) {
    throw new GenerationServiceError(message, status);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeMediaUrlList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((url): url is string => typeof url === 'string' && url.length > 0);
}

function normalizeReferenceHandle(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!normalized) {
    return null;
  }

  const handle = `@${normalized}`;
  return isValidElementHandle(handle) ? handle : null;
}

function normalizeReferenceImageInputs(value: ReferenceImageInput[] | undefined) {
  return (value || [])
    .map((reference, index) => {
      if (!reference || typeof reference !== 'object') {
        return null;
      }

      const url = typeof reference.url === 'string' ? reference.url.trim() : '';
      if (!url) {
        return null;
      }

      return {
        url,
        handle: normalizeReferenceHandle(reference.handle),
        displayName: normalizeElementDisplayName(reference.displayName, index + 1),
        storagePath: typeof reference.storagePath === 'string' ? reference.storagePath : null,
        sourceGenerationId:
          typeof reference.sourceGenerationId === 'string'
            ? reference.sourceGenerationId
            : null,
      };
    })
    .filter((reference): reference is {
      url: string;
      handle: string | null;
      displayName: string;
      storagePath: string | null;
      sourceGenerationId: string | null;
    } => Boolean(reference));
}

function normalizeKlingVideoElementInputs(value: KlingVideoElementInput[] | undefined) {
  const usedHandles = new Set<string>();

  return (value || [])
    .map((element, index) => {
      if (!element || typeof element !== 'object') {
        return null;
      }

      const url = typeof element.url === 'string' ? element.url.trim() : '';
      if (!url) {
        return null;
      }

      const displayName = normalizeElementDisplayName(
        typeof element.displayName === 'string' ? element.displayName : undefined,
        index + 1
      );
      const normalizedHandle = normalizeReferenceHandle(element.handle);
      const handle = normalizedHandle && !usedHandles.has(normalizedHandle)
        ? normalizedHandle
        : buildElementHandle(displayName, usedHandles, index + 1);

      if (normalizedHandle && handle === normalizedHandle) {
        usedHandles.add(handle);
      }

      return {
        id: typeof element.id === 'string' && element.id.trim() ? element.id : null,
        url,
        handle,
        displayName,
        storagePath: typeof element.storagePath === 'string' ? element.storagePath : null,
        sourceGenerationId:
          typeof element.sourceGenerationId === 'string'
            ? element.sourceGenerationId
            : null,
      };
    })
    .filter((element): element is {
      id: string | null;
      url: string;
      handle: string;
      displayName: string;
      storagePath: string | null;
      sourceGenerationId: string | null;
    } => Boolean(element));
}

async function resolveMediaUrls(
  supabase: SupabaseClient,
  urls: string[]
): Promise<string[]> {
  return Promise.all(urls.map((url) => resolveStoredMediaUrl(supabase, url)));
}

function normalizeDialogueTurns(dialogueTurns: DialogueTurnInput[] | undefined): DialogueTurnInput[] {
  return (dialogueTurns || [])
    .map((turn) => ({
      text: turn.text.trim(),
      voice: turn.voice.trim(),
    }))
    .filter((turn) => turn.text && turn.voice);
}

function buildVoicePromptPreview(model: VoiceoverModelId, text: string | undefined, dialogueTurns: DialogueTurnInput[]): string {
  if (model === 'text-to-dialogue-v3') {
    return dialogueTurns.map((turn) => `${turn.voice}: ${turn.text}`).join('\n');
  }

  return text?.trim() || '';
}

function getStoredWorkflowModel(workflowSettings: Record<string, unknown> | null, fallbackModel: string): string {
  const model = workflowSettings?.model;
  return typeof model === 'string' ? model : fallbackModel;
}

export function getGenerationResultUrls(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => getGenerationResultUrls(item));
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return getGenerationResultUrls(parsed);
    } catch {
      return value ? [value] : [];
    }
  }

  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    return [
      ...getGenerationResultUrls(candidate.resultUrls),
      ...getGenerationResultUrls(candidate.originUrls),
      ...getGenerationResultUrls(candidate.resultUrl),
      ...getGenerationResultUrls(candidate.url),
    ];
  }

  return [];
}

function getFirstResultUrl(value: unknown): string | null {
  return getGenerationResultUrls(value)[0] ?? null;
}

function inferOutputExtension(tempUrl: string, contentType: string, category: string | null): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  if (contentType.includes('wav') || contentType.includes('wave')) return 'wav';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
  if (contentType.includes('ogg')) return 'ogg';
  if (contentType.includes('flac')) return 'flac';
  if (contentType.includes('mp4')) return 'mp4';

  try {
    const pathname = new URL(tempUrl).pathname;
    const ext = pathname.split('.').pop();
    if (ext) return ext.toLowerCase();
  } catch {
    // Ignore URL parsing failures and fall back below.
  }

  if (category === 'image') return 'jpg';
  if (category === 'audio') return 'mp3';
  return 'mp4';
}

function getStorageBucket(category: string | null, model: string): 'generated_images' | 'generated_videos' | 'generated_audio' {
  if (category === 'audio' || isAudioModel(model)) {
    return 'generated_audio';
  }

  if (category === 'image' || isImageModel(model)) {
    return 'generated_images';
  }

  return 'generated_videos';
}

function getKieImageModelId(model: ImageModelId, referenceCount: number): string {
  if (model === 'grok-imagine-image') {
    return referenceCount > 0 ? 'grok-imagine/image-to-image' : 'grok-imagine/text-to-image';
  }

  if (model === 'gpt-image-2') {
    return referenceCount > 0 ? 'gpt-image-2-image-to-image' : 'gpt-image-2-text-to-image';
  }

  return model;
}

async function createGenerationPreviewQuietly({
  body,
  category,
  contentType,
  storagePath,
  supabase,
}: {
  body: Blob;
  category: string | null | undefined;
  contentType: string | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  try {
    const preview = await createGenerationOutputPreview({
      body,
      category,
      contentType,
      storagePath,
      supabase,
    });
    return {
      previewUrl: preview?.previewStoragePath ?? null,
      previewThumbhash: preview?.previewThumbhash ?? null,
      previewStatus: preview ? 'ready' as const : 'failed' as const,
      previewError: preview ? null : 'Unsupported or invalid visual media.',
    };
  } catch (error) {
    console.error('Failed to create generation preview poster:', error);
    return {
      previewUrl: null,
      previewThumbhash: null,
      previewStatus: 'failed' as const,
      previewError: error instanceof Error ? error.message.slice(0, 500) : 'Preview generation failed.',
    };
  }
}

function getFallbackPreviewUrl(
  category: string | null | undefined,
  contentType: string | null | undefined,
  outputUrl: string | null
) {
  if (!outputUrl) {
    return null;
  }

  return isImageGenerationPreview(category, contentType) ? outputUrl : null;
}

async function persistGeneratedOutput(
  supabase: SupabaseClient,
  settlementSupabase: SupabaseClient,
  generation: SyncableGenerationRecord,
  tempUrl: string,
  completedAt?: string | null
): Promise<GenerationTerminalSettlementStatus> {
  const bucket = getStorageBucket(generation.category, generation.model);
  const settledAt = completedAt ?? new Date().toISOString();

  try {
    const mediaResponse = await fetch(tempUrl);
    if (!mediaResponse.ok) {
      throw new Error('Failed to download generated media from KIE');
    }

    const mediaBlob = await mediaResponse.blob();
    const extension = inferOutputExtension(tempUrl, mediaBlob.type, generation.category);
    const fileName = `${generation.user_id}/generated_${generation.prediction_id}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(fileName, mediaBlob, {
        contentType: mediaBlob.type || undefined,
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload to Supabase Storage failed:', uploadError);
      return settleGenerationSucceeded(settlementSupabase, {
        predictionId: generation.prediction_id!,
        outputUrl: tempUrl,
        previewUrl: getFallbackPreviewUrl(generation.category, mediaBlob.type, tempUrl),
        previewStatus: 'failed',
        previewAttemptCount: 1,
        previewError: 'Generated output could not be persisted for preview processing.',
        completedAt: settledAt,
      });
    }

    const storagePath = `${bucket}/${fileName}`;
    const preview = await createGenerationPreviewQuietly({
      body: mediaBlob,
      category: generation.category,
      contentType: mediaBlob.type,
      storagePath,
      supabase,
    });

    return settleGenerationSucceeded(settlementSupabase, {
      predictionId: generation.prediction_id!,
      outputUrl: storagePath,
      previewUrl: preview.previewUrl,
      previewThumbhash: preview.previewThumbhash,
      previewStatus: preview.previewStatus,
      previewAttemptCount: 1,
      previewError: preview.previewError,
      previewGeneratedAt: preview.previewStatus === 'ready' ? new Date().toISOString() : null,
      completedAt: settledAt,
    });
  } catch (error) {
    console.error('Error persisting generated output:', error);
    return settleGenerationSucceeded(settlementSupabase, {
      predictionId: generation.prediction_id!,
      outputUrl: tempUrl,
      previewUrl: getFallbackPreviewUrl(generation.category, null, tempUrl),
      previewStatus: 'failed',
      previewAttemptCount: 1,
      previewError: error instanceof Error ? error.message.slice(0, 500) : 'Generated output persistence failed.',
      completedAt: settledAt,
    });
  }
}

export async function persistGeneratedOutputList(
  supabase: SupabaseClient,
  settlementSupabase: SupabaseClient,
  generation: Pick<SyncableGenerationRecord, 'id' | 'user_id' | 'prediction_id' | 'category' | 'model' | 'workflow_settings'>,
  tempUrls: string[],
  completedAt?: string | null
): Promise<PersistedGenerationOutputListResult> {
  const bucket = getStorageBucket(generation.category, generation.model);
  const outputs: PersistedGenerationOutput[] = [];
  let primaryPreview = {
    previewUrl: null as string | null,
    previewThumbhash: null as string | null,
    previewStatus: 'pending' as 'pending' | 'ready' | 'failed',
    previewError: null as string | null,
  };

  for (const [index, tempUrl] of tempUrls.entries()) {
    try {
      const mediaResponse = await fetch(tempUrl);
      if (!mediaResponse.ok) {
        throw new Error('Failed to download generated media from KIE');
      }

      const mediaBlob = await mediaResponse.blob();
      const extension = inferOutputExtension(tempUrl, mediaBlob.type, generation.category);
      const suffix = tempUrls.length > 1 ? `_${index}` : '';
      const fileName = `${generation.user_id}/generated_${generation.prediction_id}${suffix}.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(fileName, mediaBlob, {
          contentType: mediaBlob.type || undefined,
          upsert: true,
        });

      if (uploadError) {
        throw uploadError;
      }

      outputs.push({
        index,
        storagePath: `${bucket}/${fileName}`,
      });

      if (index === 0) {
        primaryPreview = await createGenerationPreviewQuietly({
          body: mediaBlob,
          category: generation.category,
          contentType: mediaBlob.type,
          storagePath: `${bucket}/${fileName}`,
          supabase,
        });
      }
    } catch (error) {
      console.error(`Error persisting generated output ${index}:`, error);
      outputs.push({
        index,
        storagePath: tempUrl,
      });
      if (index === 0) {
        primaryPreview = {
          previewUrl: getFallbackPreviewUrl(generation.category, null, tempUrl),
          previewThumbhash: null,
          previewStatus: 'failed',
          previewError: error instanceof Error ? error.message.slice(0, 500) : 'Preview generation failed.',
        };
      }
    }
  }

  const primaryOutput = outputs[0]?.storagePath ?? null;
  const workflowSettings = generation.workflow_settings && typeof generation.workflow_settings === 'object'
    ? generation.workflow_settings
    : {};
  const shouldStoreOutputList = generation.model === 'grok-imagine-image' || outputs.length > 1;
  const updatePayload: Record<string, unknown> = {
    status: 'succeeded',
    output_url: primaryOutput,
    preview_url: primaryPreview.previewUrl ?? getFallbackPreviewUrl(generation.category, null, primaryOutput),
    preview_thumbhash: primaryPreview.previewThumbhash,
    preview_status: primaryPreview.previewStatus,
    preview_attempt_count: 1,
    preview_error: primaryPreview.previewError,
    preview_generated_at: primaryPreview.previewStatus === 'ready' ? new Date().toISOString() : null,
    completed_at: completedAt ?? new Date().toISOString(),
  };

  if (shouldStoreOutputList) {
    updatePayload.workflow_settings = {
      ...workflowSettings,
      outputs,
      primaryOutputIndex: 0,
    };
  }

  const status = await settleGenerationSucceeded(settlementSupabase, {
    predictionId: generation.prediction_id!,
    outputUrl: primaryOutput,
    previewUrl: typeof updatePayload.preview_url === 'string' ? updatePayload.preview_url : null,
    previewThumbhash: typeof updatePayload.preview_thumbhash === 'string' ? updatePayload.preview_thumbhash : null,
    previewStatus: typeof updatePayload.preview_status === 'string' ? updatePayload.preview_status : null,
    previewAttemptCount: typeof updatePayload.preview_attempt_count === 'number' ? updatePayload.preview_attempt_count : null,
    previewError: typeof updatePayload.preview_error === 'string' ? updatePayload.preview_error : null,
    previewGeneratedAt: typeof updatePayload.preview_generated_at === 'string' ? updatePayload.preview_generated_at : null,
    completedAt: completedAt ?? new Date().toISOString(),
    workflowSettings: updatePayload.workflow_settings as Record<string, unknown> | undefined,
  });

  return { status, outputs };
}

async function markGenerationFailed(
  creditSupabase: SupabaseClient,
  generation: SyncableGenerationRecord,
  completedAt?: string | null
): Promise<'failed' | 'succeeded'> {
  if (!generation.prediction_id) {
    throw new GenerationServiceError('Generation does not have a provider task id.', 500);
  }

  return settleGenerationFailed(
    creditSupabase,
    generation.prediction_id,
    completedAt ?? new Date().toISOString(),
  );
}

function isVeoGeneration(generation: SyncableGenerationRecord): boolean {
  const workflowModel = getStoredWorkflowModel(generation.workflow_settings, generation.model);
  return workflowModel === 'veo-3.1' || generation.model === 'veo3' || generation.model === 'veo3_fast';
}

function getProviderPayloadTaskData(
  providerPayload: Record<string, unknown> | null | undefined,
  predictionId: string,
): Record<string, unknown> | null {
  if (!providerPayload) return null;

  const taskId = extractKieWebhookTaskId(providerPayload);
  if (taskId && taskId !== predictionId) return null;

  const data = isRecord(providerPayload.data) ? providerPayload.data : providerPayload;
  return isRecord(data) ? data : null;
}

async function syncSingleGenerationStatusFromProviderPayload(
  supabase: SupabaseClient,
  creditSupabase: SupabaseClient,
  generation: SyncableGenerationRecord,
  providerPayload: Record<string, unknown> | null | undefined,
): Promise<Exclude<GenerationSyncStatus, 'missing'> | null> {
  if (!generation.prediction_id || !['processing', 'waiting'].includes(generation.status)) {
    return null;
  }

  const taskData = getProviderPayloadTaskData(providerPayload, generation.prediction_id);
  if (!taskData) return null;

  const kind = getGenerationKind({
    category: generation.category,
    model: generation.model,
  });
  const fallbackStartedAtMs = Number.isNaN(Date.parse(generation.created_at))
    ? null
    : Date.parse(generation.created_at);

  if (isVeoGeneration(generation)) {
    const successFlag = taskData.successFlag;
    const responseData = isRecord(taskData.response) ? taskData.response : null;
    const timing = normalizeVeoGenerationTiming({
      kind,
      task: taskData,
      fallbackStartedAtMs,
    });

    if (successFlag === 1) {
      const tempUrl = getFirstResultUrl(responseData?.resultUrls) || getFirstResultUrl(responseData?.originUrls);
      if (tempUrl) {
        return persistGeneratedOutput(supabase, creditSupabase, generation, tempUrl, toIsoTimestamp(timing.completedAtMs));
      } else {
        return settleGenerationSucceeded(creditSupabase, {
          predictionId: generation.prediction_id,
          completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
        });
      }
    }

    if (successFlag === 2 || successFlag === 3) {
      return markGenerationFailed(creditSupabase, generation, toIsoTimestamp(timing.completedAtMs));
    }

    return null;
  }

  const state = taskData.state;
  const timing = normalizeMarketGenerationTiming({
    kind,
    task: taskData,
    fallbackStartedAtMs,
  });

  if (state === 'success') {
    let tempUrl: string | null = null;
    let result: unknown = null;

    try {
      result = typeof taskData.resultJson === 'string'
        ? JSON.parse(taskData.resultJson)
        : taskData.resultJson;
      tempUrl = getFirstResultUrl(result);
    } catch (error) {
      console.error('Error parsing generation result JSON:', error);
    }

    if (tempUrl) {
      if (generation.model === 'grok-imagine-image') {
        return (await persistGeneratedOutputList(
          supabase,
          creditSupabase,
          generation,
          getGenerationResultUrls(result),
          toIsoTimestamp(timing.completedAtMs)
        )).status;
      } else {
        return persistGeneratedOutput(supabase, creditSupabase, generation, tempUrl, toIsoTimestamp(timing.completedAtMs));
      }
    } else {
      return settleGenerationSucceeded(creditSupabase, {
        predictionId: generation.prediction_id,
        completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
      });
    }
  }

  if (state === 'fail') {
    return markGenerationFailed(creditSupabase, generation, toIsoTimestamp(timing.completedAtMs));
  }

  return null;
}

async function syncSingleGenerationStatus(
  supabase: SupabaseClient,
  creditSupabase: SupabaseClient,
  generation: SyncableGenerationRecord
): Promise<Exclude<GenerationSyncStatus, 'missing'>> {
  if (!generation.prediction_id || !['processing', 'waiting'].includes(generation.status)) {
    if (generation.status === 'succeeded' || generation.status === 'failed') {
      return generation.status;
    }
    return 'skipped';
  }

  const kind = getGenerationKind({
    category: generation.category,
    model: generation.model,
  });
  const fallbackStartedAtMs = Number.isNaN(Date.parse(generation.created_at))
    ? null
    : Date.parse(generation.created_at);

  if (isVeoGeneration(generation)) {
    const response = await fetch(`https://api.kie.ai/api/v1/veo/record-info?taskId=${generation.prediction_id}`, {
      headers: { Authorization: `Bearer ${KIE_API_KEY}` },
    });
    const data = await response.json();

    if (!response.ok || data.code !== 200) {
      throw new Error(data.msg || 'Failed to check Veo status');
    }

    const successFlag = data.data?.successFlag;
    const responseData = data.data?.response;
    const timing = normalizeVeoGenerationTiming({
      kind,
      task: data.data,
      fallbackStartedAtMs,
    });

    if (successFlag === 1) {
      const tempUrl = getFirstResultUrl(responseData?.resultUrls) || getFirstResultUrl(responseData?.originUrls);
      if (tempUrl) {
        return persistGeneratedOutput(supabase, creditSupabase, generation, tempUrl, toIsoTimestamp(timing.completedAtMs));
      } else {
        return settleGenerationSucceeded(creditSupabase, {
          predictionId: generation.prediction_id,
          completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
        });
      }
    }

    if (successFlag === 2 || successFlag === 3) {
      return markGenerationFailed(creditSupabase, generation, toIsoTimestamp(timing.completedAtMs));
    }

    const nextStatus = timing.appStatus === 'waiting' ? 'waiting' : 'processing';
    if (generation.status !== nextStatus) {
      await supabase.from('generations').update({ status: nextStatus }).eq('id', generation.id);
    }

    return nextStatus;
  }

  const response = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${generation.prediction_id}`, {
    headers: { Authorization: `Bearer ${KIE_API_KEY}` },
  });
  const data = await response.json();

  if (!response.ok || data.code !== 200) {
    throw new Error(data.msg || 'Failed to check generation status');
  }

  const state = data.data?.state;
  const timing = normalizeMarketGenerationTiming({
    kind,
    task: data.data,
    fallbackStartedAtMs,
  });

  if (state === 'success') {
    let tempUrl: string | null = null;
    let result: unknown = null;

    try {
      result = typeof data.data?.resultJson === 'string'
        ? JSON.parse(data.data.resultJson)
        : data.data?.resultJson;
      tempUrl = getFirstResultUrl(result);
    } catch (error) {
      console.error('Error parsing generation result JSON:', error);
    }

    if (tempUrl) {
      if (generation.model === 'grok-imagine-image') {
        return (await persistGeneratedOutputList(
          supabase,
          creditSupabase,
          generation,
          getGenerationResultUrls(result),
          toIsoTimestamp(timing.completedAtMs)
        )).status;
      } else {
        return persistGeneratedOutput(supabase, creditSupabase, generation, tempUrl, toIsoTimestamp(timing.completedAtMs));
      }
    } else {
      return settleGenerationSucceeded(creditSupabase, {
        predictionId: generation.prediction_id,
        completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
      });
    }
  }

  if (state === 'fail') {
    return markGenerationFailed(creditSupabase, generation, toIsoTimestamp(timing.completedAtMs));
  }

  const nextStatus = timing.appStatus === 'waiting' ? 'waiting' : 'processing';
  if (generation.status !== nextStatus) {
    await supabase.from('generations').update({ status: nextStatus }).eq('id', generation.id);
  }
  return nextStatus;
}

async function loadGenerationByPredictionId(
  supabase: SupabaseClient,
  predictionId: string,
): Promise<SyncableGenerationRecord | null> {
  const { data, error } = await supabase
    .from('generations')
    .select('id, user_id, prediction_id, status, output_url, model, category, workflow_settings, created_at, completed_at')
    .eq('prediction_id', predictionId)
    .single();

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === 'PGRST116') return null;
    throw error;
  }

  return (data ?? null) as SyncableGenerationRecord | null;
}

export async function syncGenerationStatusByPredictionId(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  predictionId: string;
  providerPayload?: Record<string, unknown> | null;
}): Promise<GenerationStatusSyncResult> {
  requireApiKey();

  const generation = await loadGenerationByPredictionId(params.supabase, params.predictionId);
  if (!generation) {
    return { found: false, status: 'missing', generation: null };
  }

  const status = await syncSingleGenerationStatusFromProviderPayload(
    params.supabase,
    params.creditSupabase,
    generation,
    params.providerPayload,
  ) ?? await syncSingleGenerationStatus(params.supabase, params.creditSupabase, generation);
  const updatedGeneration = await loadGenerationByPredictionId(params.supabase, params.predictionId);

  return {
    found: true,
    status,
    generation: updatedGeneration ?? { ...generation, status },
  };
}

export async function syncGenerationStatuses(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  generationIds: string[];
}) {
  requireApiKey();

  const generationIds = Array.from(new Set(params.generationIds.filter(Boolean)));
  if (generationIds.length === 0) {
    return;
  }

  const { data: generations } = await params.supabase
    .from('generations')
    .select('id, user_id, prediction_id, status, output_url, model, category, workflow_settings, created_at, completed_at')
    .in('id', generationIds);

  for (const generation of (generations || []) as SyncableGenerationRecord[]) {
    try {
      await syncSingleGenerationStatus(params.supabase, params.creditSupabase, generation);
    } catch (error) {
      console.error(`Failed to sync generation ${generation.id}:`, error);
    }
  }
}

export async function startImageGeneration(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  userId: string;
  clientRequestKeyHash?: string | null;
  prompt: string;
  model: ImageModelId;
  references?: ReferenceImageInput[];
  imageUrls?: string[];
  elements?: ImageElementDescriptor[];
  aspectRatio?: string;
  resolution?: ImageResolution;
  qualityMode?: ImageQualityMode;
  outputFormat?: ImageOutputFormat;
  googleSearch?: boolean;
  quotedCostCredits?: number;
  sourceGenerationId?: string | null;
}): Promise<GenerationStartResult> {
  requireApiKey();
  const {
    supabase,
    creditSupabase,
    userId,
    clientRequestKeyHash = null,
    prompt,
    model,
    references,
    imageUrls = [],
    elements = [],
    aspectRatio: requestedAspectRatio,
    resolution = '1K',
    qualityMode = 'standard',
    outputFormat = 'jpg',
    googleSearch = false,
    quotedCostCredits,
    sourceGenerationId = null,
  } = params;

  const trimmedPrompt = trimPrompt(prompt, 'A prompt is required to generate an image.');
  const modelConfig = IMAGE_MODELS[model];
  if (!modelConfig) {
    throw new GenerationServiceError(`Unsupported image model: ${model}`, 400);
  }
  const aspectRatio = requestedAspectRatio ?? (model === 'grok-imagine-image' ? modelConfig.aspectRatios[0] : 'auto');

  assertGenerationRequest(
    (modelConfig.aspectRatios as readonly string[]).includes(aspectRatio),
    `${modelConfig.displayName} does not support aspect ratio ${aspectRatio}.`
  );

  assertGenerationRequest(
    isValidImageResolution(model, resolution, aspectRatio),
    `${modelConfig.displayName} supports ${getImageResolutionOptions(model, aspectRatio).join(', ')} at aspect ratio ${aspectRatio}.`
  );

  if (model === 'grok-imagine-image') {
    assertGenerationRequest(
      isValidImageQualityMode(qualityMode),
      'Unsupported quality mode for Grok Imagine.'
    );
  }

  if (modelConfig.supportsOutputFormat) {
    assertGenerationRequest(
      (modelConfig.outputFormats as readonly string[]).includes(outputFormat),
      `${modelConfig.displayName} does not support ${outputFormat.toUpperCase()} output.`
    );
  }

  const normalizedReferences = normalizeReferenceImageInputs(references);
  const normalizedElements = normalizedReferences.length > 0
    ? normalizedReferences
      .filter((reference) => Boolean(reference.handle))
      .map((reference, index) => ({
        id: `reference-${index + 1}`,
        displayName: reference.displayName,
        handle: reference.handle!,
        storagePath: reference.storagePath,
        sourceGenerationId: reference.sourceGenerationId,
      }) satisfies ImageElementDescriptor)
    : normalizeSubmittedElementDescriptors(elements);
  const resolvedImageUrls = await resolveMediaUrls(
    supabase,
    normalizedReferences.length > 0
      ? normalizedReferences.map((reference) => reference.url)
      : normalizeMediaUrlList(imageUrls)
  );

  assertGenerationRequest(
    normalizedElements.length <= resolvedImageUrls.length,
    'Element metadata does not match the uploaded element images.'
  );

  assertGenerationRequest(
    resolvedImageUrls.length <= modelConfig.maxImages,
    `${modelConfig.displayName} supports up to ${modelConfig.maxImages} total reference images.`
  );

  const unknownPromptHandles = findUnknownPromptHandles(
    trimmedPrompt,
    normalizedElements.map((element) => element.handle)
  );
  if (unknownPromptHandles.length > 0) {
    throw new GenerationServiceError(
      `Unknown element mention${unknownPromptHandles.length > 1 ? 's' : ''}: ${unknownPromptHandles.join(', ')}`,
      400
    );
  }

  const compiledPrompt = normalizedElements.length > 0
    ? compileImagePromptWithElements(trimmedPrompt, normalizedElements)
    : trimmedPrompt;

  const computedCost = getImageCost(model, resolution, {
    qualityMode,
    referenceCount: resolvedImageUrls.length,
  });
  const cost = resolveQuotedGenerationCost(computedCost, quotedCostCredits);
  const providerModel = getKieImageModelId(model, resolvedImageUrls.length);

  let generationId: string | null = null;
  let predictionId: string | null = null;
  try {
    let input: Record<string, unknown>;

    if (model === 'grok-imagine-image') {
      input = {
        prompt: compiledPrompt,
        nsfw_checker: true,
      };

      if (resolvedImageUrls.length > 0) {
        input.image_urls = resolvedImageUrls;
      } else {
        input.aspect_ratio = aspectRatio;
        input.enable_pro = qualityMode === 'quality';
      }
    } else if (model === 'gpt-image-2') {
      input = {
        prompt: compiledPrompt,
        aspect_ratio: aspectRatio,
        resolution,
      };

      if (resolvedImageUrls.length > 0) {
        input.input_urls = resolvedImageUrls;
      }
    } else {
      input = {
        prompt: compiledPrompt,
        aspect_ratio: aspectRatio,
        resolution,
      };
      input.output_format = outputFormat;

      if (modelConfig.supportsGoogleSearch) {
        input.google_search = googleSearch;
      }

      if (resolvedImageUrls.length > 0) {
        input.image_input = resolvedImageUrls;
      }
    }

    const reservation = await startGenerationRecord(creditSupabase, {
      user_id: userId,
      model,
      cost,
      client_request_key_hash: clientRequestKeyHash,
      prompt: trimmedPrompt,
      category: 'image',
      source_generation_id: sourceGenerationId,
      workflow_settings: {
        model,
        providerModel,
        aspectRatio,
        resolution,
        ...(model === 'grok-imagine-image' ? { qualityMode } : {}),
        outputFormat,
        googleSearch,
        ...(normalizedElements.length > 0
          ? {
              elements: normalizedElements,
              promptMode: 'element-mentions-v1' as const,
              compiledPrompt,
            }
          : {}),
      },
    });
    generationId = reservation.generationId;
    if (reservation.predictionId) {
      return {
        predictionId: reservation.predictionId,
        remainingCredits: reservation.remainingCredits,
        cost: reservation.cost,
        generationId,
        idempotentReplay: reservation.idempotentReplay,
      };
    }

    predictionId = await createKieTask({ model: providerModel, input }, undefined, { generationId });
    await markGenerationProviderStarted(creditSupabase, generationId, predictionId);

    await persistGenerationInputMedia({
      supabase,
      generationId,
      userId,
      candidates: collectImageInputCandidates({
        resolvedImageUrls,
        elements: normalizedElements,
      }),
    });

    return {
      predictionId,
      remainingCredits: reservation.remainingCredits,
      cost: reservation.cost,
      generationId,
    };
  } catch (error) {
    if (!predictionId) {
      await refundCreditsQuietly(creditSupabase, userId, cost);
      await markGenerationStartFailedQuietly(creditSupabase, generationId);
    }
    throw error;
  }
}

export async function startVideoGeneration(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  userId: string;
  clientRequestKeyHash?: string | null;
  prompt: string;
  model: VideoModelId;
  references?: ReferenceImageInput[];
  imageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  klingVideoElements?: KlingVideoElementInput[];
  isMultiShot?: boolean;
  multiPrompts?: VideoMultiPromptInput[];
  elements?: ImageElementDescriptor[];
  elementImageUrls?: string[];
  startImageUrl?: string | null;
  endImageUrl?: string | null;
  mode?: string;
  aspectRatio?: string;
  sound?: boolean;
  duration?: number;
  resolution?: string;
  fixedLens?: boolean;
  referenceMode?: 'frames' | 'elements';
  startFrame?: RemixMediaAssetDescriptor | null;
  endFrame?: RemixMediaAssetDescriptor | null;
  seedanceAssets?: SeedanceAssetCollections | null;
  quotedCostCredits?: number;
  sourceGenerationId?: string | null;
}): Promise<GenerationStartResult> {
  requireApiKey();
  const {
    supabase,
    creditSupabase,
    userId,
    clientRequestKeyHash = null,
    prompt,
    model,
    references,
    imageUrls = [],
    referenceVideoUrls = [],
    referenceAudioUrls = [],
    klingVideoElements = [],
    isMultiShot = false,
    multiPrompts,
    elements = [],
    elementImageUrls = [],
    startImageUrl = null,
    endImageUrl = null,
    mode = 'std',
    aspectRatio = '9:16',
    sound = false,
    duration = 5,
    resolution = '720p',
    fixedLens = false,
    referenceMode = 'frames',
    startFrame = null,
    endFrame = null,
    seedanceAssets = null,
    quotedCostCredits,
    sourceGenerationId = null,
  } = params;

  const selectedModel = VIDEO_MODELS[model];
  if (!selectedModel) {
    throw new GenerationServiceError(`Unsupported video model: ${model}`, 400);
  }

  const rawPrompt = typeof prompt === 'string' ? prompt : '';
  const trimmedPrompt = rawPrompt.trim();
  const normalizedReferences = normalizeReferenceImageInputs(references);
  const normalizedKlingVideoElements = normalizeKlingVideoElementInputs(klingVideoElements);
  const normalizedElements = normalizedReferences.length > 0
    ? normalizedReferences
      .filter((reference) => Boolean(reference.handle))
      .map((reference, index) => ({
        id: `reference-${index + 1}`,
        displayName: reference.displayName,
        handle: reference.handle!,
        storagePath: reference.storagePath,
        sourceGenerationId: reference.sourceGenerationId,
      }) satisfies ImageElementDescriptor)
    : normalizeSubmittedElementDescriptors(elements);
  const normalizedReferenceMode = referenceMode === 'elements' ? 'elements' : 'frames';
  const normalizedStartFrame = normalizeRemixMediaAssetDescriptor(startFrame, 'image');
  const normalizedEndFrame = normalizeRemixMediaAssetDescriptor(endFrame, 'image');
  const useLegacyFrameUrls = normalizedReferences.length === 0 && (
    normalizedReferenceMode === 'frames'
    || Boolean(startImageUrl)
    || Boolean(endImageUrl)
    || Boolean(normalizedStartFrame)
    || Boolean(normalizedEndFrame)
  );
  const rawMultiPrompts = multiPrompts || [];
  const normalizedMultiPrompts = rawMultiPrompts.map((shot, index) => ({
    id: typeof shot.id === 'string' && shot.id.trim() ? shot.id : `shot-${index + 1}`,
    prompt: typeof shot.prompt === 'string' ? shot.prompt.trim() : '',
    duration:
      typeof shot.duration === 'number' && Number.isFinite(shot.duration)
        ? Math.max(1, Math.min(12, Math.round(shot.duration)))
        : 5,
  }));

  if (isMultiShot) {
    assertGenerationRequest(
      selectedModel.supportsMultiShot,
      `${selectedModel.displayName} does not support multi-shot video generation.`
    );
    assertGenerationRequest(
      normalizedMultiPrompts.length > 0,
      'At least one shot is required for multi-shot mode.'
    );
    assertGenerationRequest(
      normalizedMultiPrompts.every((shot) => shot.prompt.length > 0),
      'All multi-shot entries need a text prompt.'
    );
  } else {
    trimPrompt(prompt, 'A prompt is required to generate a video.');
  }

  const videoElementSupport = getVideoElementSupport(model, { mode, isMultiShot });
  const isSeedance2Family = isSeedance2VideoModelId(model);
  const resolvedReferenceImageUrls = normalizedReferences.length > 0
    ? await resolveMediaUrls(supabase, normalizedReferences.map((reference) => reference.url))
    : useLegacyFrameUrls
      ? []
      : await resolveMediaUrls(supabase, normalizeMediaUrlList(imageUrls));
  const resolvedReferenceVideoUrls = isSeedance2Family
    ? await resolveMediaUrls(supabase, normalizeMediaUrlList(referenceVideoUrls))
    : [];
  const resolvedReferenceAudioUrls = isSeedance2Family
    ? await resolveMediaUrls(supabase, normalizeMediaUrlList(referenceAudioUrls))
    : [];
  const resolvedKlingVideoElements = model === 'kling-3.0-video'
    ? await Promise.all(normalizedKlingVideoElements.map(async (element) => ({
        ...element,
        url: await resolveStoredMediaUrl(supabase, element.url),
      })))
    : [];
  const resolvedElementImageUrls = normalizedReferences.length > 0
    ? resolvedReferenceImageUrls.filter((_url, index) => Boolean(normalizedReferences[index]?.handle))
    : await resolveMediaUrls(supabase, normalizeMediaUrlList(elementImageUrls));
  const resolvedLegacyImageUrls = normalizedReferences.length > 0
    ? []
    : useLegacyFrameUrls
      ? await resolveMediaUrls(supabase, normalizeMediaUrlList(imageUrls))
      : [];
  const totalReferenceImageCount = resolvedReferenceImageUrls.length;

  if (totalReferenceImageCount > 0 && !videoElementSupport.enabled) {
    throw new GenerationServiceError(
      videoElementSupport.reason || 'Image references are not available in this video mode.',
      400
    );
  }

  if (totalReferenceImageCount > videoElementSupport.maxElements) {
    throw new GenerationServiceError(
      `This video mode supports up to ${videoElementSupport.maxElements} image reference${videoElementSupport.maxElements === 1 ? '' : 's'}.`,
      400
    );
  }

  if (resolvedReferenceVideoUrls.length > 3) {
    throw new GenerationServiceError(
      'Seedance 2 supports up to 3 reference videos per run.',
      400
    );
  }

  if (normalizedKlingVideoElements.length > 0 && model !== 'kling-3.0-video') {
    throw new GenerationServiceError(
      'Kling video elements are only available for Kling 3.0 Cinematic.',
      400
    );
  }

  if (resolvedKlingVideoElements.length > 3) {
    throw new GenerationServiceError(
      'Kling 3.0 Video supports up to 3 named video elements per run.',
      400
    );
  }

  const resolvedStartImageUrl = startImageUrl ? await resolveStoredMediaUrl(supabase, startImageUrl) : null;
  const resolvedEndImageUrl = endImageUrl ? await resolveStoredMediaUrl(supabase, endImageUrl) : null;

  const frameImageUrls = [
    resolvedStartImageUrl || resolvedLegacyImageUrls[0] || null,
    resolvedEndImageUrl || resolvedLegacyImageUrls[1] || null,
  ].filter((url): url is string => Boolean(url));
  const grokVideoImageUrls = model === 'grok-imagine-video'
    ? (
        resolvedReferenceImageUrls.length > 0
          ? resolvedReferenceImageUrls
          : (resolvedElementImageUrls.length > 0 ? resolvedElementImageUrls : frameImageUrls)
      )
    : [];

  if (totalReferenceImageCount > 0 && frameImageUrls.length > 0) {
    throw new GenerationServiceError(
      'Image references cannot be combined with start or end frames in the same run.',
      400
    );
  }

  if (isMultiShot && frameImageUrls.length > 1) {
    throw new GenerationServiceError(
      'End frames are not available in multi-shot mode.',
      400
    );
  }

  if (model === 'grok-imagine-video' && grokVideoImageUrls.length > 1) {
    throw new GenerationServiceError(
      'Grok Imagine Video supports up to 1 image reference per run.',
      400
    );
  }

  if (normalizedElements.length > 0 && normalizedElements.length !== resolvedElementImageUrls.length) {
    throw new GenerationServiceError(
      'Element metadata does not match the uploaded video element images.',
      400
    );
  }

  const activePrompt = isMultiShot ? '' : trimmedPrompt;
  const validPromptHandles = [
    ...normalizedElements.map((element) => element.handle),
    ...resolvedKlingVideoElements.map((element) => element.handle),
  ];
  const unknownPromptHandles = !isMultiShot
    ? findUnknownPromptHandles(activePrompt, validPromptHandles)
    : [];
  if (unknownPromptHandles.length > 0) {
    throw new GenerationServiceError(
      `Unknown element mention${unknownPromptHandles.length > 1 ? 's' : ''}: ${unknownPromptHandles.join(', ')}`,
      400
    );
  }

  const compiledPrompt = normalizedElements.length > 0
    ? compilePromptWithElements(trimmedPrompt, normalizedElements, 'video')
    : trimmedPrompt;
  if (isMultiShot && model === 'kling-3.0-video') {
    const unknownShotHandles = normalizedMultiPrompts.flatMap((shot) =>
      findUnknownPromptHandles(shot.prompt, validPromptHandles)
    );
    const uniqueUnknownShotHandles = Array.from(new Set(unknownShotHandles));
    if (uniqueUnknownShotHandles.length > 0) {
      throw new GenerationServiceError(
        `Unknown element mention${uniqueUnknownShotHandles.length > 1 ? 's' : ''}: ${uniqueUnknownShotHandles.join(', ')}`,
        400
      );
    }
  }
  const hasAnySeedanceReference = isSeedance2Family && (
    totalReferenceImageCount > 0
    || frameImageUrls.length > 0
    || resolvedReferenceVideoUrls.length > 0
    || resolvedReferenceAudioUrls.length > 0
  );
  const effectiveReferenceMode = isSeedance2Family
    ? (hasAnySeedanceReference ? 'references' : normalizedReferenceMode)
    : totalReferenceImageCount > 0
      ? 'references'
      : frameImageUrls.length > 0
        ? 'frames'
        : normalizedReferenceMode;

  assertGenerationRequest(
    (selectedModel.aspectRatios as readonly string[]).includes(aspectRatio),
    `Unsupported aspect ratio for ${selectedModel.displayName}`
  );
  if (selectedModel.modeOptions.length > 0) {
    assertGenerationRequest(
      selectedModel.modeOptions.some((option) => option.value === mode),
      `Unsupported mode for ${selectedModel.displayName}`
    );
  }
  if (selectedModel.resolutions.length > 0) {
    assertGenerationRequest(
      (selectedModel.resolutions as readonly string[]).includes(resolution),
      `Unsupported resolution for ${selectedModel.displayName}`
    );
  }
  if (!isMultiShot && selectedModel.provider !== 'veo' && !isValidVideoDuration(model, duration)) {
    throw new GenerationServiceError(`Unsupported duration for ${selectedModel.displayName}`, 400);
  }

  const soundEnabled = selectedModel.supportsSound ? sound : false;
  const totalDuration = isMultiShot
    ? normalizedMultiPrompts.reduce((total, shot) => total + (shot.duration || 0), 0)
    : (selectedModel.provider === 'veo' ? selectedModel.durations[0] : duration);
  const computedCost = getVideoCost(model, {
    mode,
    sound: soundEnabled,
    durationSeconds: totalDuration,
    resolution,
    hasReferenceVideo: resolvedReferenceVideoUrls.length > 0,
  });
  const cost = resolveQuotedGenerationCost(computedCost, quotedCostCredits);

  let generationId: string | null = null;
  let predictionId: string | null = null;
  try {
    let endpoint = 'https://api.kie.ai/api/v1/jobs/createTask';
    let body: Record<string, unknown>;
    let providerModelId = selectedModel.apiModelId || mode;
    const referenceImageUrls = resolvedReferenceImageUrls;
    const seedanceReferenceImageUrls = referenceImageUrls.length > 0
      ? referenceImageUrls
      : (resolvedElementImageUrls.length > 0 ? resolvedElementImageUrls : frameImageUrls);
    const requestedMode = mode;
    const providerMode = model === 'grok-imagine-video' && grokVideoImageUrls.length > 0 && mode === 'spicy'
      ? 'normal'
      : mode;

    if (selectedModel.provider === 'kling') {
      const input: Record<string, unknown> = {
        mode,
        aspect_ratio: aspectRatio,
        sound: soundEnabled,
        multi_shots: Boolean(isMultiShot),
        duration: String(totalDuration),
      };

      if (isMultiShot) {
        input.multi_prompt = normalizedMultiPrompts.map((shot) => ({
          prompt: shot.prompt,
          duration: shot.duration,
        }));
      } else {
        input.prompt = compiledPrompt;
      }

      if (frameImageUrls.length > 0) {
        input.image_urls = frameImageUrls;
      }

      if (resolvedKlingVideoElements.length > 0) {
        input.kling_elements = resolvedKlingVideoElements.map((element) => ({
          name: element.handle.replace(/^@/, ''),
          description: element.displayName,
          element_input_video_urls: [element.url],
        }));
      }

      body = {
        model: selectedModel.apiModelId,
        input,
      };
    } else if (selectedModel.provider === 'seedance') {
      if (isSeedance2Family) {
        const input: Record<string, unknown> = {
          prompt: compiledPrompt,
          resolution,
          aspect_ratio: aspectRatio,
          duration,
          generate_audio: soundEnabled,
          web_search: false,
          return_last_frame: false,
        };

        if (seedanceReferenceImageUrls.length > 0) {
          input.reference_image_urls = seedanceReferenceImageUrls;
        }

        if (resolvedReferenceVideoUrls.length > 0) {
          input.reference_video_urls = resolvedReferenceVideoUrls;
        }

        if (resolvedReferenceAudioUrls.length > 0) {
          input.reference_audio_urls = resolvedReferenceAudioUrls;
        }

        body = {
          model: selectedModel.apiModelId,
          input,
        };
      } else {
        const input: Record<string, unknown> = {
          prompt: compiledPrompt,
          aspect_ratio: aspectRatio,
          resolution,
          duration: String(duration),
          fixed_lens: fixedLens,
          generate_audio: soundEnabled,
        };

        if (referenceImageUrls.length > 0) {
          input.input_urls = referenceImageUrls;
        } else if (frameImageUrls.length > 0) {
          input.input_urls = frameImageUrls;
        }

        body = {
          model: selectedModel.apiModelId,
          input,
        };
      }
    } else if (selectedModel.provider === 'grok') {
      providerModelId = grokVideoImageUrls.length > 0
        ? 'grok-imagine/image-to-video'
        : 'grok-imagine/text-to-video';

      const input: Record<string, unknown> = {
        prompt: compiledPrompt,
        mode: providerMode,
        duration: totalDuration,
        resolution,
        nsfw_checker: true,
      };

      if (grokVideoImageUrls.length > 0) {
        input.image_urls = grokVideoImageUrls;
      } else {
        input.aspect_ratio = aspectRatio;
      }

      body = {
        model: providerModelId,
        input,
      };
    } else {
      endpoint = 'https://api.kie.ai/api/v1/veo/generate';
      providerModelId = mode === 'veo3' ? 'veo3' : 'veo3_fast';
      body = {
        prompt: compiledPrompt,
        model: providerModelId,
        aspectRatio,
        generationType: referenceImageUrls.length > 0
          ? 'REFERENCE_2_VIDEO'
          : (frameImageUrls.length > 0 ? 'FIRST_AND_LAST_FRAMES_2_VIDEO' : 'TEXT_2_VIDEO'),
        ...(referenceImageUrls.length > 0
          ? { imageUrls: referenceImageUrls }
          : (frameImageUrls.length > 0 ? { imageUrls: frameImageUrls } : {})),
      };
    }

    const reservation = await startGenerationRecord(creditSupabase, {
      user_id: userId,
      model: providerModelId,
      cost,
      duration: totalDuration,
      client_request_key_hash: clientRequestKeyHash,
      prompt: isMultiShot ? normalizedMultiPrompts[0]?.prompt || '' : trimmedPrompt,
      category: 'video',
      source_generation_id: sourceGenerationId,
      workflow_settings: {
        model,
        mode,
        ...(model === 'grok-imagine-video'
          ? {
              providerModel: providerModelId,
              requestedMode,
              providerMode,
            }
          : {}),
        aspectRatio,
        sound: soundEnabled,
        duration: totalDuration,
        multiPrompts: isMultiShot
          ? normalizedMultiPrompts.map((shot) => ({
              id: shot.id || null,
              prompt: shot.prompt,
              duration: shot.duration,
            }))
          : undefined,
        resolution,
        fixedLens,
        referenceMode: effectiveReferenceMode,
        ...(seedanceReferenceImageUrls.length > 0
          ? { referenceImageUrls: seedanceReferenceImageUrls }
          : {}),
        ...(resolvedReferenceVideoUrls.length > 0
          ? { referenceVideoUrls: resolvedReferenceVideoUrls }
          : {}),
        ...(resolvedReferenceAudioUrls.length > 0
          ? { referenceAudioUrls: resolvedReferenceAudioUrls }
          : {}),
        ...(resolvedKlingVideoElements.length > 0
          ? {
              klingVideoElements: resolvedKlingVideoElements.map((element) => ({
                id: element.id,
                url: element.url,
                handle: element.handle,
                displayName: element.displayName,
                storagePath: element.storagePath,
                sourceGenerationId: element.sourceGenerationId,
              })),
            }
          : {}),
        ...(hasSeedanceAssetCollections(seedanceAssets)
          ? { seedanceAssets }
          : {}),
        ...(normalizedElements.length > 0
          ? {
              elements: normalizedElements,
              promptMode: 'element-mentions-v1' as const,
              compiledPrompt,
            }
          : {}),
        ...(effectiveReferenceMode === 'frames' && normalizedStartFrame
          ? { startFrame: normalizedStartFrame }
          : {}),
        ...(effectiveReferenceMode === 'frames' && normalizedEndFrame
          ? { endFrame: normalizedEndFrame }
          : {}),
      },
    });
    generationId = reservation.generationId;
    if (reservation.predictionId) {
      return {
        predictionId: reservation.predictionId,
        remainingCredits: reservation.remainingCredits,
        cost: reservation.cost,
        generationId,
        idempotentReplay: reservation.idempotentReplay,
      };
    }

    predictionId = await createKieTask(body, endpoint, { generationId });
    await markGenerationProviderStarted(creditSupabase, generationId, predictionId);

    const videoInputCandidates: PersistGenerationInputCandidate[] = [];
    let inputSortOrder = 0;
    const referenceImageCandidates = normalizedElements.length > 0
      ? collectImageInputCandidates({
          resolvedImageUrls: resolvedElementImageUrls,
          elements: normalizedElements,
        })
      : collectImageInputCandidates({
          resolvedImageUrls: resolvedReferenceImageUrls,
          elements: [],
        });

    for (const candidate of referenceImageCandidates) {
      videoInputCandidates.push({
        ...candidate,
        sortOrder: inputSortOrder++,
      });
    }

    const startFrameSourceUrl = resolvedStartImageUrl || resolvedLegacyImageUrls[0] || null;
    const endFrameSourceUrl = resolvedEndImageUrl || resolvedLegacyImageUrls[1] || null;

    if (effectiveReferenceMode === 'frames' && startFrameSourceUrl) {
      videoInputCandidates.push({
        mediaType: 'image',
        role: 'start_frame',
        label: normalizedStartFrame?.label ?? 'Start frame',
        sourceUrl: startFrameSourceUrl,
        sourceStoragePath: normalizedStartFrame?.storagePath ?? startImageUrl ?? null,
        sourceGenerationId: normalizedStartFrame?.sourceGenerationId ?? null,
        sortOrder: inputSortOrder++,
      });
    }

    if (effectiveReferenceMode === 'frames' && endFrameSourceUrl) {
      videoInputCandidates.push({
        mediaType: 'image',
        role: 'end_frame',
        label: normalizedEndFrame?.label ?? 'End frame',
        sourceUrl: endFrameSourceUrl,
        sourceStoragePath: normalizedEndFrame?.storagePath ?? endImageUrl ?? null,
        sourceGenerationId: normalizedEndFrame?.sourceGenerationId ?? null,
        sortOrder: inputSortOrder++,
      });
    }

    for (const [index, element] of resolvedKlingVideoElements.entries()) {
      videoInputCandidates.push({
        mediaType: 'video',
        role: 'reference_video',
        label: element.displayName,
        sourceUrl: element.url,
        sourceStoragePath: element.storagePath,
        sourceGenerationId: element.sourceGenerationId,
        sortOrder: inputSortOrder++,
        metadata: {
          id: element.id,
          displayName: element.displayName,
          handle: element.handle,
          provider: 'kling',
          elementIndex: index,
        },
      });
    }
    videoInputCandidates.push(
      ...collectSeedanceAssetCandidates({
        assets: seedanceAssets,
        offset: inputSortOrder,
      })
    );

    await persistGenerationInputMedia({
      supabase,
      generationId,
      userId,
      candidates: videoInputCandidates,
    });

    return {
      predictionId,
      remainingCredits: reservation.remainingCredits,
      cost: reservation.cost,
      generationId,
    };
  } catch (error) {
    if (!predictionId) {
      await refundCreditsQuietly(creditSupabase, userId, cost);
      await markGenerationStartFailedQuietly(creditSupabase, generationId);
    }
    throw error;
  }
}

export async function startMotionGeneration(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  userId: string;
  clientRequestKeyHash?: string | null;
  prompt: string;
  model: MotionModelId;
  referenceVideoUrl: string;
  characterImageUrl: string;
  duration: number;
  characterOrientation?: 'video' | 'image';
  mode?: '720p' | '1080p';
  sourceGenerationId?: string | null;
  characterImage?: RemixMediaAssetDescriptor | null;
  referenceVideo?: RemixMediaAssetDescriptor | null;
  quotedCostCredits?: number;
}): Promise<GenerationStartResult> {
  requireApiKey();
  const {
    supabase,
    creditSupabase,
    userId,
    clientRequestKeyHash = null,
    prompt,
    model,
    referenceVideoUrl,
    characterImageUrl,
    duration,
    characterOrientation = 'video',
    mode = '720p',
    sourceGenerationId = null,
    characterImage = null,
    referenceVideo = null,
    quotedCostCredits,
  } = params;

  if (!referenceVideoUrl || !characterImageUrl) {
    throw new Error('Motion generation requires both a reference video and a character image.');
  }

  const selectedModel = MOTION_MODELS[model];
  if (!selectedModel) {
    throw new Error(`Unsupported motion model: ${model}`);
  }

  const computedCost = getMotionCost(model, mode, duration);
  const cost = resolveQuotedGenerationCost(computedCost, quotedCostCredits);
  try {
    buildKieWebhookCallbackUrl();
  } catch (error) {
    console.error('Kie webhook callback is not configured:', error);
    throw new GenerationServiceError('Server configuration error: webhook secret missing', 500);
  }

  let generationId: string | null = null;
  let predictionId: string | null = null;
  try {
    const reservation = await startGenerationRecord(creditSupabase, {
      user_id: userId,
      model: selectedModel.apiModelId,
      duration,
      cost,
      client_request_key_hash: clientRequestKeyHash,
      prompt: prompt.trim(),
      category: 'video',
      creation_mode: 'motion',
      source_generation_id: sourceGenerationId,
      workflow_settings: {
        creationMode: 'motion',
        model,
        characterOrientation,
        mode,
        duration,
        ...(characterImage ? { characterImage } : {}),
        ...(referenceVideo ? { referenceVideo } : {}),
      },
    });
    generationId = reservation.generationId;
    if (reservation.predictionId) {
      return {
        predictionId: reservation.predictionId,
        remainingCredits: reservation.remainingCredits,
        cost: reservation.cost,
        generationId,
        idempotentReplay: reservation.idempotentReplay,
      };
    }

    predictionId = await createKieTask({
      model: selectedModel.apiModelId,
      input: {
        prompt: prompt.trim() || 'The character follows the reference performance naturally.',
        input_urls: [characterImageUrl],
        video_urls: [referenceVideoUrl],
        character_orientation: characterOrientation,
        mode,
      },
    }, undefined, { generationId });
    await markGenerationProviderStarted(creditSupabase, generationId, predictionId);

    await persistGenerationInputMedia({
      supabase,
      generationId,
      userId,
      candidates: [
        {
          mediaType: 'image',
          role: 'character_image',
          label: characterImage?.label ?? 'Character image',
          sourceUrl: characterImageUrl,
          sourceStoragePath: characterImage?.storagePath ?? null,
          sourceGenerationId: characterImage?.sourceGenerationId ?? null,
          sortOrder: 0,
        },
        {
          mediaType: 'video',
          role: 'motion_reference_video',
          label: referenceVideo?.label ?? 'Motion reference video',
          sourceUrl: referenceVideoUrl,
          sourceStoragePath: referenceVideo?.storagePath ?? null,
          sourceGenerationId: referenceVideo?.sourceGenerationId ?? null,
          sortOrder: 1,
        },
      ],
    });

    return {
      predictionId,
      remainingCredits: reservation.remainingCredits,
      cost: reservation.cost,
      generationId,
    };
  } catch (error) {
    if (!predictionId) {
      await refundCreditsQuietly(creditSupabase, userId, cost);
      await markGenerationStartFailedQuietly(creditSupabase, generationId);
    }
    throw error;
  }
}

export async function startVoiceoverGeneration(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  userId: string;
  model: VoiceoverModelId;
  text?: string;
  voice?: string;
  languageCode?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  timestamps?: boolean;
  dialogueTurns?: DialogueTurnInput[];
}): Promise<GenerationStartResult> {
  requireApiKey();
  const {
    creditSupabase,
    userId,
    model,
    text,
    voice = 'Rachel',
    languageCode = 'en',
    stability = 0.4,
    similarityBoost = 0.8,
    style = 0,
    speed = 1,
    timestamps = false,
    dialogueTurns,
  } = params;

  const selectedModel = VOICEOVER_MODELS[model];
  if (!selectedModel) {
    throw new Error(`Unsupported voiceover model: ${model}`);
  }

  const normalizedDialogueTurns = normalizeDialogueTurns(dialogueTurns);
  const trimmedText = text?.trim() || '';
  if (model === 'text-to-dialogue-v3') {
    if (normalizedDialogueTurns.length === 0) {
      throw new Error('Dialogue generation requires at least one dialogue turn.');
    }
  } else if (!trimmedText) {
    throw new Error('Voiceover generation requires a prompt input.');
  }

  const cost = getVoiceoverCost(model, {
    text: trimmedText,
    dialogueTurns: normalizedDialogueTurns,
  });
  const remainingCredits = await deductCreditsOrThrow(creditSupabase, userId, cost);
  let generationId: string | null = null;
  let predictionId: string | null = null;

  try {
    let input: Record<string, unknown>;
    if (model === 'text-to-dialogue-v3') {
      input = {
        dialogue: normalizedDialogueTurns,
        stability,
      };

      if (languageCode.trim()) {
        input.language_code = languageCode.trim();
      }
    } else {
      input = {
        text: trimmedText,
        voice: voice.trim() || 'Rachel',
        stability,
        similarity_boost: similarityBoost,
        style,
        speed,
        timestamps,
      };

      if (languageCode.trim()) {
        input.language_code = languageCode.trim();
      }
    }

    generationId = await reserveGenerationRecord(creditSupabase, {
      user_id: userId,
      model: selectedModel.apiModelId,
      cost,
      prompt: buildVoicePromptPreview(model, trimmedText, normalizedDialogueTurns),
      category: 'audio',
      workflow_settings: {
        model,
        voice,
        languageCode,
        stability,
        similarityBoost,
        style,
        speed,
        timestamps,
        dialogueTurns: normalizedDialogueTurns,
      },
    });

    predictionId = await createKieTask({
      model: selectedModel.apiModelId,
      input,
    }, undefined, { generationId });
    await markGenerationProviderStarted(creditSupabase, generationId, predictionId);

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId,
    };
  } catch (error) {
    if (!predictionId) {
      await refundCreditsQuietly(creditSupabase, userId, cost);
      await markGenerationStartFailedQuietly(creditSupabase, generationId);
    }
    throw error;
  }
}

export async function startSoundEffectGeneration(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  userId: string;
  prompt: string;
  model?: SoundEffectModelId;
  duration?: number;
  loop?: boolean;
  promptInfluence?: number;
  outputFormat?: 'mp3' | 'wav';
}): Promise<GenerationStartResult> {
  requireApiKey();
  const {
    creditSupabase,
    userId,
    prompt,
    model = 'sound-effect-v2',
    duration = 5,
    loop = false,
    promptInfluence = 0.3,
    outputFormat = 'mp3',
  } = params;

  const trimmedPrompt = trimPrompt(prompt, 'Sound-effect generation requires a prompt input.');
  const selectedModel = SOUND_EFFECT_MODELS[model];
  if (!selectedModel) {
    throw new Error(`Unsupported sound-effect model: ${model}`);
  }

  const cost = getSoundEffectCost(model, duration);
  const remainingCredits = await deductCreditsOrThrow(creditSupabase, userId, cost);
  let generationId: string | null = null;
  let predictionId: string | null = null;

  try {
    generationId = await reserveGenerationRecord(creditSupabase, {
      user_id: userId,
      model: selectedModel.apiModelId,
      cost,
      duration,
      prompt: trimmedPrompt,
      category: 'audio',
      workflow_settings: {
        model,
        duration,
        loop,
        promptInfluence,
        outputFormat,
      },
    });

    predictionId = await createKieTask({
      model: selectedModel.apiModelId,
      input: {
        text: trimmedPrompt,
        loop,
        duration_seconds: duration,
        prompt_influence: promptInfluence,
        output_format: outputFormat,
      },
    }, undefined, { generationId });
    await markGenerationProviderStarted(creditSupabase, generationId, predictionId);

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId,
    };
  } catch (error) {
    if (!predictionId) {
      await refundCreditsQuietly(creditSupabase, userId, cost);
      await markGenerationStartFailedQuietly(creditSupabase, generationId);
    }
    throw error;
  }
}
