import type { SupabaseClient } from '@supabase/supabase-js';

import { enforceBackendRateLimit, MEDIA_GENERATION_RATE_LIMIT } from '@/lib/backend-rate-limit';
import { quotePublishedGenerationModel } from '@/lib/generation-model-catalog-store';
import {
  startVideoGeneration,
  type KlingVideoElementInput,
  type VideoMultiPromptInput,
} from '@/lib/generation-services';
import {
  getGenerationStartIdempotencyKey,
  getGenerationStartLockOwner,
  hashGenerationStartRequest,
  withGenerationStartIdempotency,
} from '@/lib/generation-start-idempotency';
import type { ImageElementDescriptor } from '@/lib/image-elements';
import type { VideoModelId } from '@/lib/models';
import type { RemixMediaAssetDescriptor } from '@/lib/remix-source';
import type { SeedanceAssetCollections } from '@/lib/seedance-assets';
import { resolveSourceGenerationId } from '@/lib/source-generation';

export type VideoGenerationStartRouteClient = SupabaseClient;

export type VideoGenerationStartRoutePayload = {
  success: true;
  predictionId: string;
  generationId: string | null;
  status: 'processing';
  remainingCredits: number;
  cost: number;
  idempotentReplay?: true;
};

type StartVideoGenerationForRouteInput = {
  request: Request;
  body: Record<string, unknown>;
  userId: string;
  supabase: VideoGenerationStartRouteClient;
  adminSupabase: VideoGenerationStartRouteClient;
  persistInputMedia?: boolean;
};

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function readObject<T>(value: unknown): T | null {
  return value && typeof value === 'object' ? value as T : null;
}

function buildImageUrls(startImageUrl: string | null, endImageUrl: string | null): string[] {
  const imageUrls: string[] = [];
  if (startImageUrl) imageUrls.push(startImageUrl);
  if (endImageUrl) imageUrls.push(endImageUrl);
  return imageUrls;
}

function getQuotedDuration(body: Record<string, unknown>): unknown {
  const multiPrompts = readArray<{ duration?: unknown }>(body.multiPrompts);
  if (!body.isMultiShot || multiPrompts.length === 0) {
    return body.duration ?? 5;
  }

  return multiPrompts.reduce((total, shot) => {
    const value = shot?.duration;
    return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }, 0);
}

export async function startVideoGenerationForRoute({
  request,
  body,
  userId,
  supabase,
  adminSupabase,
  persistInputMedia = true,
}: StartVideoGenerationForRouteInput): Promise<VideoGenerationStartRoutePayload> {
  const selectedModel = readString(body.model, 'kling-3.0-video');
  const requestedSettings = readObject<Record<string, unknown>>(body.settings) ?? {};
  const elements = readArray<ImageElementDescriptor>(body.elements);
  const elementImageUrls = readArray<string>(body.elementImageUrls);
  const referenceVideoUrls = readArray<string>(body.referenceVideoUrls);
  const referenceAudioUrls = readArray<string>(body.referenceAudioUrls);
  const preparedAudioIds = readArray<string>(body.preparedAudioIds);
  const characterIds = readArray<string>(body.characterIds);
  const klingVideoElements = readArray<KlingVideoElementInput>(body.klingVideoElements);
  const usesReusableReferences = body.referenceMode === 'elements';
  const startImageUrl = readOptionalString(body.startImageUrl);
  const endImageUrl = readOptionalString(body.endImageUrl);
  const quote = await quotePublishedGenerationModel({
    kind: 'video',
    modelId: selectedModel,
    settings: {
      mode: requestedSettings.mode ?? body.mode ?? 'std',
      aspectRatio: requestedSettings.aspectRatio ?? body.aspectRatio ?? '16:9',
      sound: requestedSettings.sound ?? body.sound ?? false,
      duration: requestedSettings.duration ?? getQuotedDuration(body),
      resolution: requestedSettings.resolution ?? body.resolution ?? '720p',
      fixedLens: requestedSettings.fixedLens ?? body.fixedLens ?? false,
      isMultiShot: requestedSettings.isMultiShot ?? Boolean(body.isMultiShot),
      referenceMode: requestedSettings.referenceMode ?? (usesReusableReferences ? 'elements' : 'frames'),
    },
    inputCounts: {
      images: usesReusableReferences
        ? Math.max(elements.length, elementImageUrls.length)
        : Number(Boolean(startImageUrl)) + Number(Boolean(endImageUrl)),
      videos: (usesReusableReferences ? referenceVideoUrls.length : 0) + klingVideoElements.length,
      audios: usesReusableReferences ? referenceAudioUrls.length : 0,
      preparedAudios: usesReusableReferences ? preparedAudioIds.length : 0,
      characters: usesReusableReferences ? characterIds.length : 0,
    },
    catalogRevision: readOptionalString(body.catalogRevision),
  }, { platform: request.headers.get('x-magicbooklet-client') === 'mobile' ? 'mobile' : 'web' });

  const sourceGenerationId = await resolveSourceGenerationId(
    supabase,
    userId,
    readOptionalString(body.sourceGenerationId)
  );

  await enforceBackendRateLimit(adminSupabase, {
    ...MEDIA_GENERATION_RATE_LIMIT,
    key: userId,
  });

  const normalizedSettings = quote.normalizedSettings;
  const result = await withGenerationStartIdempotency({
    client: adminSupabase,
    userId,
    idempotencyKey: getGenerationStartIdempotencyKey(request, body),
    requestHash: hashGenerationStartRequest(body),
    owner: getGenerationStartLockOwner(request),
    start: (clientRequestKeyHash) => startVideoGeneration({
      supabase,
      creditSupabase: adminSupabase,
      userId,
      clientRequestKeyHash,
      model: selectedModel as VideoModelId,
      prompt: readString(body.prompt, ''),
      isMultiShot: Boolean(body.isMultiShot),
      multiPrompts: Array.isArray(body.multiPrompts)
        ? body.multiPrompts as VideoMultiPromptInput[]
        : undefined,
      elements,
      elementImageUrls,
      referenceVideoUrls,
      referenceAudioUrls,
      preparedAudioIds,
      characterIds,
      klingVideoElements,
      startImageUrl,
      endImageUrl,
      imageUrls: buildImageUrls(startImageUrl, endImageUrl),
      mode: String(normalizedSettings.mode),
      aspectRatio: String(normalizedSettings.aspectRatio),
      sound: Boolean(normalizedSettings.sound),
      duration: Number(normalizedSettings.duration),
      resolution: String(normalizedSettings.resolution),
      fixedLens: Boolean(normalizedSettings.fixedLens),
      referenceMode: body.referenceMode === 'elements' ? 'elements' : 'frames',
      startFrame: readObject<RemixMediaAssetDescriptor>(body.startFrame),
      endFrame: readObject<RemixMediaAssetDescriptor>(body.endFrame),
      seedanceAssets: readObject<SeedanceAssetCollections>(body.seedanceAssets),
      persistInputMedia,
      quotedCostCredits: quote.costCredits,
      sourceGenerationId,
    }),
  });

  return {
    success: true,
    predictionId: result.predictionId,
    generationId: result.generationId ?? null,
    status: 'processing',
    remainingCredits: result.remainingCredits,
    cost: result.cost,
    ...(result.idempotentReplay ? { idempotentReplay: true } : {}),
  };
}
