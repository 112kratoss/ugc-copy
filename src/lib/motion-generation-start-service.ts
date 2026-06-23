import type { SupabaseClient } from '@supabase/supabase-js';

import { enforceBackendRateLimit, MEDIA_GENERATION_RATE_LIMIT } from '@/lib/backend-rate-limit';
import { quoteGenerationModel } from '@/lib/generation-model-catalog';
import { startMotionGeneration } from '@/lib/generation-services';
import {
  getGenerationStartIdempotencyKey,
  getGenerationStartLockOwner,
  withGenerationStartIdempotency,
} from '@/lib/generation-start-idempotency';
import { MOTION_MODELS, type MotionModelId } from '@/lib/models';
import { normalizeRemixMediaAssetDescriptor } from '@/lib/remix-source';
import { resolveSourceGenerationId } from '@/lib/source-generation';

export type MotionGenerationStartRouteClient = SupabaseClient;

export type MotionGenerationStartRoutePayload = {
  success: true;
  predictionId: string;
  generationId: string | null;
  status: 'processing';
  remainingCredits: number;
  cost: number;
  idempotentReplay?: true;
};

type StartMotionGenerationForRouteInput = {
  request: Request;
  body: Record<string, unknown>;
  userId: string;
  supabase: MotionGenerationStartRouteClient;
  adminSupabase: MotionGenerationStartRouteClient;
};

export class MotionGenerationStartValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'MotionGenerationStartValidationError';
    this.status = status;
  }
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function requireString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export async function startMotionGenerationForRoute({
  request,
  body,
  userId,
  supabase,
  adminSupabase,
}: StartMotionGenerationForRouteInput): Promise<MotionGenerationStartRoutePayload> {
  const selectedModel = readString(body.model, 'kling-2.6');
  const selectedSourceGenerationId = readOptionalString(body.sourceGenerationId);
  const referenceVideoUrl = requireString(body.referenceVideoUrl);
  const characterImageUrl = requireString(body.characterImageUrl);
  if (!referenceVideoUrl || !characterImageUrl) {
    throw new MotionGenerationStartValidationError('Missing referenceVideoUrl or characterImageUrl');
  }

  const modelConfig = MOTION_MODELS[selectedModel as MotionModelId];
  if (!modelConfig) {
    throw new MotionGenerationStartValidationError(`Unsupported model: ${selectedModel}`);
  }

  const requestedDuration = readFiniteNumber(body.duration ?? 10, 10);
  if (requestedDuration <= 0 || requestedDuration > modelConfig.maxDuration) {
    throw new MotionGenerationStartValidationError(
      `Invalid duration. Must be between 1 and ${modelConfig.maxDuration} seconds.`,
    );
  }

  const quote = quoteGenerationModel({
    kind: 'motion',
    modelId: selectedModel,
    settings: {
      resolution: body.mode ?? '720p',
      characterOrientation: body.characterOrientation ?? 'video',
      duration: requestedDuration,
    },
    inputCounts: { images: 1, videos: 1, audios: 0 },
    catalogRevision: readOptionalString(body.catalogRevision),
  });

  const sourceGenerationId = await resolveSourceGenerationId(
    supabase,
    userId,
    selectedSourceGenerationId,
  );

  await enforceBackendRateLimit(adminSupabase, {
    ...MEDIA_GENERATION_RATE_LIMIT,
    key: userId,
  });

  const normalizedSettings = quote.normalizedSettings;
  const characterOrientation = String(normalizedSettings.characterOrientation);
  const mode = String(normalizedSettings.resolution);
  const result = await withGenerationStartIdempotency({
    client: adminSupabase,
    userId,
    idempotencyKey: getGenerationStartIdempotencyKey(request, body),
    owner: getGenerationStartLockOwner(request),
    start: (clientRequestKeyHash) => startMotionGeneration({
      supabase,
      creditSupabase: adminSupabase,
      userId,
      clientRequestKeyHash,
      model: selectedModel as MotionModelId,
      referenceVideoUrl,
      characterImageUrl,
      duration: Number(normalizedSettings.duration),
      characterOrientation: characterOrientation === 'image' ? 'image' : 'video',
      mode: mode === '1080p' ? '1080p' : '720p',
      prompt: readString(body.prompt, ''),
      sourceGenerationId,
      characterImage: normalizeRemixMediaAssetDescriptor(body.characterImage, 'image'),
      referenceVideo: normalizeRemixMediaAssetDescriptor(body.referenceVideo, 'video'),
      quotedCostCredits: quote.costCredits,
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
