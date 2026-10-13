import type { SupabaseClient } from '@supabase/supabase-js';

import { enforceBackendRateLimit, MEDIA_GENERATION_RATE_LIMIT } from '@/lib/backend-rate-limit';
import { quotePublishedGenerationModel } from '@/lib/generation-model-catalog-store';
import { resolveGenerationMediaSource, startMotionGeneration } from '@/lib/generation-services';
import {
  getGenerationStartIdempotencyKey,
  getGenerationStartLockOwner,
  hashGenerationStartRequest,
  withGenerationStartIdempotency,
} from '@/lib/generation-start-idempotency';
import { MOTION_MODELS, type MotionModelId } from '@/lib/models';
import { normalizeRemixMediaAssetDescriptor } from '@/lib/remix-source';
import { resolveSourceGenerationId } from '@/lib/source-generation';
import { ReferenceDurationChangedError } from '@/lib/unified-generation-start-service';
import { probeMediaDurationSeconds } from '@/lib/video-rendition';

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

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * The reference clip's length, measured the way POST /api/generations measures
 * it: a motion output runs as long as its clip, so the clip is what is priced,
 * not the `duration` a caller names. Only an HTTPS object is ever read.
 */
async function measureReferenceVideoSeconds(
  supabase: MotionGenerationStartRouteClient,
  referenceVideoUrl: string,
  userId: string,
): Promise<number> {
  const source = await resolveGenerationMediaSource(supabase, referenceVideoUrl, userId);
  const measured = /^https:\/\//i.test(source) ? await probeMediaDurationSeconds(source) : null;
  if (measured === null || !Number.isFinite(measured) || measured <= 0) {
    throw new MotionGenerationStartValidationError(
      'The length of a reference file could not be verified. Upload it again, then retry.',
      422,
    );
  }
  return measured;
}

export async function startMotionGenerationForRoute({
  request,
  body,
  userId,
  supabase,
  adminSupabase,
}: StartMotionGenerationForRouteInput): Promise<MotionGenerationStartRoutePayload> {
  const selectedModel = readString(body.model, 'kling-2.6');
  const requestedSettings = readObject(body.settings);
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

  const requestedDuration = readFiniteNumber(requestedSettings.duration ?? body.duration ?? 10, 10);
  if (requestedDuration <= 0 || requestedDuration > modelConfig.maxDuration) {
    throw new MotionGenerationStartValidationError(
      `Invalid duration. Must be between 1 and ${modelConfig.maxDuration} seconds.`,
    );
  }

  const platform = request.headers.get('x-magicbooklet-client') === 'mobile' ? 'mobile' : 'web';
  const quoteAtDuration = (duration: number, catalogRevision: string | null) => quotePublishedGenerationModel({
    kind: 'motion',
    modelId: selectedModel,
    settings: {
      resolution: requestedSettings.resolution ?? body.mode ?? '720p',
      characterOrientation: requestedSettings.characterOrientation ?? body.characterOrientation ?? 'video',
      duration,
    },
    inputCounts: { images: 1, videos: 1, audios: 0 },
    catalogRevision,
  }, { platform });
  // The price the caller was shown, for the length it reported.
  const quote = await quoteAtDuration(requestedDuration, readOptionalString(body.catalogRevision));

  const sourceGenerationId = await resolveSourceGenerationId(
    adminSupabase,
    userId,
    selectedSourceGenerationId,
  );

  await enforceBackendRateLimit(adminSupabase, {
    ...MEDIA_GENERATION_RATE_LIMIT,
    key: userId,
  });

  const result = await withGenerationStartIdempotency({
    client: adminSupabase,
    userId,
    idempotencyKey: getGenerationStartIdempotencyKey(request, body),
    requestHash: hashGenerationStartRequest(body),
    owner: getGenerationStartLockOwner(request),
    // Measured once the key is claimed: a start already accepted replays
    // without reading its clip again.
    start: async (clientRequestKeyHash) => {
      const measuredSeconds = await measureReferenceVideoSeconds(supabase, referenceVideoUrl, userId);
      const measuredDuration = Math.max(1, Math.ceil(measuredSeconds));
      const billableQuote = measuredDuration === Number(quote.normalizedSettings.duration)
        ? quote
        : await quoteAtDuration(measuredDuration, quote.catalogRevision);
      // Never charge more than the price the caller saw: a longer clip than
      // reported is refused with its measured length (the body names one
      // clip, input 0), and a shorter one is charged as measured.
      if (billableQuote.costCredits > quote.costCredits) {
        throw new ReferenceDurationChangedError(
          [{ index: 0, slot: 'referenceVideo', durationSeconds: measuredSeconds }],
          quote.costCredits,
          billableQuote.costCredits,
        );
      }

      const normalizedSettings = billableQuote.normalizedSettings;
      const characterOrientation = String(normalizedSettings.characterOrientation);
      const mode = String(normalizedSettings.resolution);
      return startMotionGeneration({
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
        quotedCostCredits: billableQuote.costCredits,
        catalogRevision: billableQuote.catalogRevision,
      });
    },
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
