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
import { buildKieWebhookCallbackUrl } from '@/lib/kie-webhook';
import type { GenerationStartResult } from '@/lib/generation-start-idempotency';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

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

interface SyncableGenerationRecord {
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

export interface PersistedGenerationOutput {
  index: number;
  storagePath: string;
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

async function refundCreditsQuietly(creditSupabase: SupabaseClient, userId: string, amount: number) {
  try {
    await creditSupabase.rpc('refund_credits', { p_user_id: userId, p_amount: amount });
  } catch (error) {
    console.error('Failed to refund credits:', error);
  }
}

async function createKieTask(body: Record<string, unknown>, endpoint = 'https://api.kie.ai/api/v1/jobs/createTask') {
  requireApiKey();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok || data.code !== 200) {
    throw new Error(data.msg || 'Provider rejected the request');
  }

  return data.data.taskId as string;
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
  generation: SyncableGenerationRecord,
  tempUrl: string,
  completedAt?: string | null
) {
  const bucket = getStorageBucket(generation.category, generation.model);

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
      await supabase
        .from('generations')
        .update({
          status: 'succeeded',
          output_url: tempUrl,
          preview_url: getFallbackPreviewUrl(generation.category, mediaBlob.type, tempUrl),
          preview_status: 'failed',
          preview_attempt_count: 1,
          preview_error: 'Generated output could not be persisted for preview processing.',
          completed_at: completedAt ?? new Date().toISOString(),
        })
        .eq('id', generation.id);
      return;
    }

    const storagePath = `${bucket}/${fileName}`;
    const preview = await createGenerationPreviewQuietly({
      body: mediaBlob,
      category: generation.category,
      contentType: mediaBlob.type,
      storagePath,
      supabase,
    });

    await supabase
      .from('generations')
      .update({
        status: 'succeeded',
        output_url: storagePath,
        preview_url: preview.previewUrl,
        preview_thumbhash: preview.previewThumbhash,
        preview_status: preview.previewStatus,
        preview_attempt_count: 1,
        preview_error: preview.previewError,
        preview_generated_at: preview.previewStatus === 'ready' ? new Date().toISOString() : null,
        completed_at: completedAt ?? new Date().toISOString(),
      })
      .eq('id', generation.id);
  } catch (error) {
    console.error('Error persisting generated output:', error);
    await supabase
      .from('generations')
      .update({
        status: 'succeeded',
        output_url: tempUrl,
        preview_url: getFallbackPreviewUrl(generation.category, null, tempUrl),
        preview_status: 'failed',
        preview_attempt_count: 1,
        preview_error: error instanceof Error ? error.message.slice(0, 500) : 'Generated output persistence failed.',
        completed_at: completedAt ?? new Date().toISOString(),
      })
      .eq('id', generation.id);
  }
}

export async function persistGeneratedOutputList(
  supabase: SupabaseClient,
  generation: Pick<SyncableGenerationRecord, 'id' | 'user_id' | 'prediction_id' | 'category' | 'model' | 'workflow_settings'>,
  tempUrls: string[],
  completedAt?: string | null
): Promise<PersistedGenerationOutput[]> {
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

  await supabase
    .from('generations')
    .update(updatePayload)
    .eq('id', generation.id);

  return outputs;
}

async function markGenerationFailed(
  supabase: SupabaseClient,
  creditSupabase: SupabaseClient,
  generation: SyncableGenerationRecord,
  completedAt?: string | null
) {
  await supabase
    .from('generations')
    .update({ status: 'failed', completed_at: completedAt ?? new Date().toISOString() })
    .eq('id', generation.id);
  await creditSupabase.rpc('refund_generation', { p_prediction_id: generation.prediction_id });
}

function isVeoGeneration(generation: SyncableGenerationRecord): boolean {
  const workflowModel = getStoredWorkflowModel(generation.workflow_settings, generation.model);
  return workflowModel === 'veo-3.1' || generation.model === 'veo3' || generation.model === 'veo3_fast';
}

async function syncSingleGenerationStatus(
  supabase: SupabaseClient,
  creditSupabase: SupabaseClient,
  generation: SyncableGenerationRecord
) {
  if (!generation.prediction_id || !['processing', 'waiting'].includes(generation.status)) {
    return;
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
        await persistGeneratedOutput(supabase, generation, tempUrl, toIsoTimestamp(timing.completedAtMs));
      } else {
        await supabase
          .from('generations')
          .update({
            status: 'succeeded',
            completed_at: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
          })
          .eq('id', generation.id);
      }
      return;
    }

    if (successFlag === 2 || successFlag === 3) {
      await markGenerationFailed(supabase, creditSupabase, generation, toIsoTimestamp(timing.completedAtMs));
      return;
    }

    const nextStatus = timing.appStatus === 'waiting' ? 'waiting' : 'processing';
    if (generation.status !== nextStatus) {
      await supabase.from('generations').update({ status: nextStatus }).eq('id', generation.id);
    }

    return;
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
        await persistGeneratedOutputList(
          supabase,
          generation,
          getGenerationResultUrls(result),
          toIsoTimestamp(timing.completedAtMs)
        );
      } else {
        await persistGeneratedOutput(supabase, generation, tempUrl, toIsoTimestamp(timing.completedAtMs));
      }
    } else {
      await supabase
        .from('generations')
        .update({
          status: 'succeeded',
          completed_at: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
        })
        .eq('id', generation.id);
    }
    return;
  }

  if (state === 'fail') {
    await markGenerationFailed(supabase, creditSupabase, generation, toIsoTimestamp(timing.completedAtMs));
    return;
  }

  const nextStatus = timing.appStatus === 'waiting' ? 'waiting' : 'processing';
  if (generation.status !== nextStatus) {
    await supabase.from('generations').update({ status: nextStatus }).eq('id', generation.id);
  }
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

  const cost = getImageCost(model, resolution, {
    qualityMode,
    referenceCount: resolvedImageUrls.length,
  });
  const remainingCredits = await deductCreditsOrThrow(creditSupabase, userId, cost);
  const providerModel = getKieImageModelId(model, resolvedImageUrls.length);

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

    const predictionId = await createKieTask({ model: providerModel, input });
    const insert = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        model,
        cost,
        prediction_id: predictionId,
        client_request_key_hash: clientRequestKeyHash,
        status: 'processing',
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
      })
      .select('id')
      .single();

    await persistGenerationInputMedia({
      supabase,
      generationId: insert.data?.id,
      userId,
      candidates: collectImageInputCandidates({
        resolvedImageUrls,
        elements: normalizedElements,
      }),
    });

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId: insert.data?.id,
    };
  } catch (error) {
    await refundCreditsQuietly(creditSupabase, userId, cost);
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
  const cost = getVideoCost(model, {
    mode,
    sound: soundEnabled,
    durationSeconds: totalDuration,
    resolution,
    hasReferenceVideo: resolvedReferenceVideoUrls.length > 0,
  });
  const remainingCredits = await deductCreditsOrThrow(creditSupabase, userId, cost);

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

    const predictionId = await createKieTask(body, endpoint);
    const insert = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        model: providerModelId,
        cost,
        duration: totalDuration,
        prediction_id: predictionId,
        client_request_key_hash: clientRequestKeyHash,
        status: 'processing',
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
      })
      .select('id')
      .single();

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
      generationId: insert.data?.id,
      userId,
      candidates: videoInputCandidates,
    });

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId: insert.data?.id,
    };
  } catch (error) {
    await refundCreditsQuietly(creditSupabase, userId, cost);
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
  } = params;

  if (!referenceVideoUrl || !characterImageUrl) {
    throw new Error('Motion generation requires both a reference video and a character image.');
  }

  const selectedModel = MOTION_MODELS[model];
  if (!selectedModel) {
    throw new Error(`Unsupported motion model: ${model}`);
  }

  const cost = getMotionCost(model, mode, duration);
  let callbackUrl: string;
  try {
    callbackUrl = buildKieWebhookCallbackUrl();
  } catch (error) {
    console.error('Kie webhook callback is not configured:', error);
    throw new GenerationServiceError('Server configuration error: webhook secret missing', 500);
  }
  const remainingCredits = await deductCreditsOrThrow(creditSupabase, userId, cost);

  try {
    const predictionId = await createKieTask({
      model: selectedModel.apiModelId,
      callBackUrl: callbackUrl,
      input: {
        prompt: prompt.trim() || 'The character follows the reference performance naturally.',
        input_urls: [characterImageUrl],
        video_urls: [referenceVideoUrl],
        character_orientation: characterOrientation,
        mode,
      },
    });

    const insert = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        model: selectedModel.apiModelId,
        duration,
        cost,
        prediction_id: predictionId,
        client_request_key_hash: clientRequestKeyHash,
        status: 'processing',
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
      })
      .select('id')
      .single();

    await persistGenerationInputMedia({
      supabase,
      generationId: insert.data?.id,
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
      remainingCredits,
      cost,
      generationId: insert.data?.id,
    };
  } catch (error) {
    await refundCreditsQuietly(creditSupabase, userId, cost);
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
    supabase,
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

    const predictionId = await createKieTask({
      model: selectedModel.apiModelId,
      input,
    });

    const insert = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        model: selectedModel.apiModelId,
        cost,
        prediction_id: predictionId,
        status: 'processing',
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
      })
      .select('id')
      .single();

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId: insert.data?.id,
    };
  } catch (error) {
    await refundCreditsQuietly(creditSupabase, userId, cost);
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
    supabase,
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

  try {
    const predictionId = await createKieTask({
      model: selectedModel.apiModelId,
      input: {
        text: trimmedPrompt,
        loop,
        duration_seconds: duration,
        prompt_influence: promptInfluence,
        output_format: outputFormat,
      },
    });

    const insert = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        model: selectedModel.apiModelId,
        cost,
        duration,
        prediction_id: predictionId,
        status: 'processing',
        prompt: trimmedPrompt,
        category: 'audio',
        workflow_settings: {
          model,
          duration,
          loop,
          promptInfluence,
          outputFormat,
        },
      })
      .select('id')
      .single();

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId: insert.data?.id,
    };
  } catch (error) {
    await refundCreditsQuietly(creditSupabase, userId, cost);
    throw error;
  }
}
