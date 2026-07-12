import type { SupabaseClient } from '@supabase/supabase-js';

import { enforceBackendRateLimit, MEDIA_GENERATION_RATE_LIMIT } from '@/lib/backend-rate-limit';
import { quoteGenerationModel } from '@/lib/generation-model-catalog';
import { startImageGeneration } from '@/lib/generation-services';
import {
  getGenerationStartIdempotencyKey,
  getGenerationStartLockOwner,
  withGenerationStartIdempotency,
} from '@/lib/generation-start-idempotency';
import type { ImageElementDescriptor } from '@/lib/image-elements';
import type {
  ImageModelId,
  ImageOutputFormat,
  ImageQualityMode,
  ImageResolution,
} from '@/lib/models';
import { resolveSourceGenerationId } from '@/lib/source-generation';

export type ImageGenerationStartRouteClient = SupabaseClient;

export type ImageGenerationStartRoutePayload = {
  success: true;
  predictionId: string;
  generationId: string | null;
  status: 'processing';
  remainingCredits: number;
  cost: number;
  idempotentReplay?: true;
};

type StartImageGenerationForRouteInput = {
  request: Request;
  body: Record<string, unknown>;
  userId: string;
  supabase: ImageGenerationStartRouteClient;
  adminSupabase: ImageGenerationStartRouteClient;
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

export async function startImageGenerationForRoute({
  request,
  body,
  userId,
  supabase,
  adminSupabase,
  persistInputMedia = true,
}: StartImageGenerationForRouteInput): Promise<ImageGenerationStartRoutePayload> {
  const selectedModel = readString(body.model, 'nano-banana-2');
  const imageUrls = readArray<string>(body.imageUrls);
  const elements = readArray<ImageElementDescriptor>(body.elements);
  const quote = quoteGenerationModel({
    kind: 'image',
    modelId: selectedModel,
    settings: {
      aspectRatio: body.aspectRatio ?? 'auto',
      resolution: body.resolution ?? '1K',
      qualityMode: body.qualityMode ?? 'standard',
      outputFormat: body.outputFormat ?? 'jpg',
      googleSearch: body.googleSearch ?? false,
    },
    inputCounts: {
      images: Math.max(imageUrls.length, elements.length),
      videos: 0,
      audios: 0,
    },
    catalogRevision: readOptionalString(body.catalogRevision),
  });

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
  const idempotencyKey = getGenerationStartIdempotencyKey(request, body);
  const result = await withGenerationStartIdempotency({
    client: adminSupabase,
    userId,
    idempotencyKey,
    owner: getGenerationStartLockOwner(request),
    start: (clientRequestKeyHash) => startImageGeneration({
      supabase,
      creditSupabase: adminSupabase,
      userId,
      clientRequestKeyHash,
      model: selectedModel as ImageModelId,
      prompt: readString(body.prompt, ''),
      imageUrls,
      elements,
      aspectRatio: String(normalizedSettings.aspectRatio),
      resolution: normalizedSettings.resolution as ImageResolution,
      qualityMode: normalizedSettings.qualityMode as ImageQualityMode | undefined,
      outputFormat: normalizedSettings.outputFormat as ImageOutputFormat,
      googleSearch: Boolean(normalizedSettings.googleSearch),
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
