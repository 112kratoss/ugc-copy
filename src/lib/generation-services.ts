import { createReadStream } from 'node:fs';
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
} from '@/lib/generation-timing';
import {
  collectImageInputCandidates,
  collectSeedanceAssetCandidates,
  persistGenerationInputMedia,
  type PersistGenerationInputCandidate,
} from '@/lib/generation-input-media';
import { importSharedGenerationInputMedia } from '@/lib/generation-input-media-import';
import { resolveOwnedStoredMediaUrl } from '@/lib/server-helpers';
import { getCanonicalStoredMediaLocation } from '@/lib/storage-ownership';
import { buildKieWebhookCallbackUrl } from '@/lib/kie-webhook';
import type { GenerationStartResult } from '@/lib/generation-start-idempotency';
import {
  getPublicGenerationStartFailure,
  markHeldProviderSubmission,
  type GenerationStartFailureCode,
  type PublicGenerationStartFailure,
} from '@/lib/generation-public-failure';
export { getPublicGenerationStartFailure };
export type { GenerationStartFailureCode, PublicGenerationStartFailure };
import {
  GenerationServiceError,
  isRecord,
  KIE_API_KEY,
  requireKieGenerationConfiguration,
  resolveQuotedGenerationCost,
  supabaseErrorMessage,
} from '@/lib/generation-service-core';
export { GenerationServiceError };
import {
  settleGenerationFailed,
  settleGenerationSucceeded,
  type GenerationTerminalSettlementStatus,
} from '@/lib/generation-settlement';
export { settleGenerationFailed, settleGenerationSucceeded };
export type { GenerationTerminalSettlementStatus };
import { logBackendError, logBackendWarning } from '@/lib/backend-logger';

const TEMPLATE_START_FAILED_EVENT = 'template_generation_start_failed_after_reservation';
import {
  fetchWithProviderTimeout,
  isExternalServiceNetworkError,
  isExternalServiceTimeoutError,
  PROVIDER_TASK_CREATE_TIMEOUT_MS,
  withProviderModel,
} from '@/lib/provider-fetch';
import {
  admitProviderSubmission,
  isProviderFaultFailure,
  parseProviderRetryAfterSeconds,
  recordProviderSubmissionOutcome,
} from '@/lib/provider-admission';
import { isAllowlistedRemoteMediaUrl, type RemoteMediaKind } from '@/lib/remote-media-security';
import { stageAllowlistedRemoteMedia } from '@/lib/staged-remote-media';
import { loadGenerationModelOperationalConfig } from '@/lib/generation-model-catalog-store';
import {
  resolveProviderModelId,
  type GenerationModelOperationalConfig,
} from '@/lib/generation-model-runtime';
import type { CatalogPrimitive } from '@/lib/generation-model-catalog';
import {
  buildGenerationProviderRequest,
  type CatalogGenerationInputAsset,
  type CatalogGenerationShot,
  type GenericGenerationAdapterOperation,
} from '@/lib/generation-model-adapters';

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

export interface KlingSubjectImageInput {
  url: string;
  storagePath?: string | null;
}

/**
 * A Kling O3 named multi-image subject: 2–4 images of the same subject that the
 * provider fuses into one identity, referenced in the prompt as @handle.
 * Contract live-verified 2026-08-24 against kling-3.0-omni/text-to-video.
 */
export interface KlingSubjectInput {
  id?: string | null;
  handle?: string | null;
  displayName?: string | null;
  description?: string | null;
  images: KlingSubjectImageInput[];
}

export type TemplateGenerationContext = Readonly<{
  runId: string;
  stepId: string;
  /** Server-persisted catalog scope for fixed assets embedded in the snapshot. */
  templateId?: string;
  templateVersionId?: string | null;
}>;


function generationStartDiagnostic(error: unknown) {
  const status = error && typeof error === 'object' && 'status' in error
    && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : null;
  return {
    errorType: error instanceof GenerationServiceError
      ? 'generation_service_error'
      : error instanceof Error
        ? 'provider_error'
        : 'unknown_error',
    ...(status === null ? {} : { status }),
  };
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
export type GenerationProviderTaskAttachStatus =
  | 'attached'
  | 'already_attached'
  | 'already_settled'
  | 'prediction_conflict';

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






export async function attachGenerationProviderTask(
  supabase: SupabaseClient,
  params: {
    generationId: string;
    predictionId: string;
  },
): Promise<GenerationProviderTaskAttachStatus> {
  const { data, error } = await supabase.rpc('attach_generation_provider_task', {
    p_generation_id: params.generationId,
    p_prediction_id: params.predictionId,
  });

  if (error || !isRecord(data)) {
    throw new GenerationServiceError(
      supabaseErrorMessage(error, 'Failed to attach provider task to generation.'),
      500,
    );
  }

  const status = typeof data.status === 'string' ? data.status : null;
  if (
    status === 'attached'
    || status === 'already_attached'
    || status === 'already_settled'
    || status === 'prediction_conflict'
  ) {
    return status;
  }

  if (status === 'missing') {
    throw new GenerationServiceError('Generation not found for provider task attach.', 404);
  }

  if (status === 'invalid_request') {
    throw new GenerationServiceError('Invalid provider task attach request.', 400);
  }

  throw new GenerationServiceError('Failed to attach provider task to generation.', 500);
}

async function createKieTask(
  body: Record<string, unknown>,
  endpoint = 'https://api.kie.ai/api/v1/jobs/createTask',
  options: { generationId?: string | null; modelId?: string | null } = {},
) {
  requireKieGenerationConfiguration();
  const callbackUrl = typeof body.callBackUrl === 'string' && body.callBackUrl.trim()
    ? body.callBackUrl
    : buildKieWebhookCallbackUrl({ generationId: options.generationId });

  // F14: account-wide admission, immediately before the only outbound call that
  // creates provider work. Placed here rather than at the seven start call
  // sites for the same reason the money-bug fix went into the shared settle
  // helper — a new start path inherits the gate instead of having to remember
  // it. A rejection throws a 429 `GenerationServiceError`, which the caller's
  // existing catch refunds through the ordinary path; that is correct because
  // no request was sent, so the provider will never bill for it.
  await admitProviderSubmission({
    generationId: options.generationId,
    model: options.modelId,
  });

  let response: Response;
  try {
    // Attribute the call to the *app* model id, not `body.model`. The latter is
    // the provider's api model id, and the status-poll paths attribute using
    // `generation.model` — mixing the two id spaces in one telemetry column would
    // split a single model's traffic across two keys and break its rates.
    response = await withProviderModel(options.modelId, () => fetchWithProviderTimeout(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KIE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, callBackUrl: callbackUrl }),
    }, PROVIDER_TASK_CREATE_TIMEOUT_MS, fetch, 'KIE task creation'));
  } catch (error) {
    if (isProviderFaultFailure(error)) {
      await recordProviderSubmissionOutcome({ success: false });
    }
    throw error;
  }

  // Parsed defensively: an overloaded provider is exactly the case most likely
  // to answer with a non-JSON body, and letting that surface as a SyntaxError
  // would lose both the status code and the Retry-After the breaker needs.
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const retryAfterSeconds = parseProviderRetryAfterSeconds(response);
    if (isProviderFaultFailure(null, response.status)) {
      await recordProviderSubmissionOutcome({ success: false, retryAfterSeconds });
    }

    // A provider 429 is reported as one. It reaches the user as `provider_busy`
    // ("busy right now, please retry shortly"), which is honest here precisely
    // because this path refunds — unlike the held ambiguous-timeout case, whose
    // copy must never invite a retry.
    if (response.status === 429) {
      throw new GenerationServiceError(
        data?.msg || 'The generation provider is busy right now. Please retry shortly.',
        429,
        'provider_busy',
      );
    }

    // A gateway can accept and forward this non-idempotent POST, then lose the
    // upstream response. In that case 502/504 are outcome-ambiguous in exactly
    // the same way as a socket reset: refunding immediately can fund a second
    // provider task while the first one is still running. Direct provider 500
    // and overload 503 responses remain definitive failures.
    if (response.status === 502 || response.status === 504) {
      throw new AmbiguousProviderSubmissionError(
        data?.msg || `Provider gateway returned HTTP ${response.status} after submission.`,
        response.status,
      );
    }

    throw new Error(data?.msg || 'Provider rejected the request');
  }

  if (!data || data.code !== 200) {
    // HTTP 200 carrying a body-level rejection is how Kie reports a validation
    // failure. Deliberately not recorded as a breaker failure: one user's bad
    // input must never open the circuit for everybody.
    throw new Error(data?.msg || 'Provider rejected the request');
  }

  await recordProviderSubmissionOutcome({ success: true });

  return data.data.taskId as string;
}

class AmbiguousProviderSubmissionError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AmbiguousProviderSubmissionError';
    this.status = status;
  }
}

async function startGenerationRecord(
  supabase: SupabaseClient,
  record: Record<string, unknown>,
  templateContext?: TemplateGenerationContext,
): Promise<{
  generationId: string;
  remainingCredits: number;
  cost: number;
  predictionId?: string;
  idempotentReplay?: boolean;
}> {
  const rpcName = templateContext ? 'start_template_generation' : 'start_generation';
  const rpcArgs = templateContext
    ? {
        p_user_id: record.user_id,
        p_template_run_id: templateContext.runId,
        p_template_run_step_id: templateContext.stepId,
        p_cost: record.cost,
        p_model: record.model,
        p_category: record.category ?? null,
        p_duration: record.duration ?? null,
        p_creation_mode: record.creation_mode ?? null,
        p_source_generation_id: record.source_generation_id ?? null,
        p_client_request_key_hash: record.client_request_key_hash ?? null,
      }
    : {
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
      };
  const { data, error } = await supabase.rpc(rpcName, rpcArgs);

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

  if (status === 'template_context_not_found') {
    throw new GenerationServiceError('Template generation context was not found.', 404);
  }

  if (status === 'invalid_template_context') {
    throw new GenerationServiceError('Template generation context is invalid.', 409);
  }

  if (status === 'template_step_already_started') {
    throw new GenerationServiceError('This template step has already started.', 409);
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
  let lastStatus: GenerationProviderTaskAttachStatus | null = null;

  for (let attempt = 1; attempt <= PROVIDER_TASK_ATTACH_ATTEMPTS; attempt += 1) {
    try {
      const status = await attachGenerationProviderTask(supabase, { generationId, predictionId });
      if (status === 'attached' || status === 'already_attached') {
        return;
      }

      lastStatus = status;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  logBackendError('generation_provider_task_attach_failed', {
    generationId,
    predictionId,
    attempts: PROVIDER_TASK_ATTACH_ATTEMPTS,
    status: lastStatus,
    error: supabaseErrorMessage(lastError, 'Failed to attach provider task to generation.'),
  });
  throw new GenerationServiceError('Failed to attach provider task to generation.', 500);
}

async function settleTemplateGenerationStartFailureQuietly(params: {
  creditSupabase: SupabaseClient;
  error: unknown;
  generationId: string;
  model: string;
  templateContext: TemplateGenerationContext;
  userId: string;
  cost: number;
}) {
  if (
    params.error instanceof AmbiguousProviderSubmissionError
    || isExternalServiceTimeoutError(params.error)
    || isExternalServiceNetworkError(params.error)
  ) {
    const hold = await holdAmbiguousGenerationSubmission({
      creditSupabase: params.creditSupabase,
      generationId: params.generationId,
      userId: params.userId,
      cost: params.cost,
    });
    if (hold !== 'unrecorded') {
      if (hold === 'reserved') markHeldProviderSubmission(params.error, params.generationId);
      return;
    }
  }

  const failure = getPublicGenerationStartFailure(params.error);
  const logEntry = {
    generationId: params.generationId,
    templateRunId: params.templateContext.runId,
    templateRunStepId: params.templateContext.stepId,
    model: params.model,
    failureCode: failure.code,
    ...generationStartDiagnostic(params.error),
  };

  try {
    const { data, error } = await params.creditSupabase.rpc('settle_template_generation_start_failed', {
      p_generation_id: params.generationId,
      p_error_message: failure.message,
    });
    const status = data && typeof data === 'object' && 'status' in data
      ? (data as { status?: unknown }).status
      : null;

    if (!error && (status === 'failed' || status === 'already_failed')) {
      logBackendError(TEMPLATE_START_FAILED_EVENT, { ...logEntry, settlement: status });
      return;
    }

    // Every settlement failure now reports the same way. This used to branch on
    // a missing RPC (PGRST202/42883) and fall back to `refund_credits` — an
    // unguarded primitive that credited an arbitrary user an arbitrary amount
    // with no idempotency key and no source row, the only function left that
    // could mint credits from nothing. The branch was rolling-deploy
    // compatibility for a database older than the code, which
    // production-release.yml makes impossible: it migrates, then stages, then
    // promotes, so the database is never behind. The RPC has been live since
    // 20260711201026.
    logBackendError(TEMPLATE_START_FAILED_EVENT, {
      ...logEntry,
      settlement: 'failed',
      settlementError: supabaseErrorMessage(error, `Unexpected settlement status: ${String(status)}`),
    });
  } catch (settlementError) {
    logBackendError(TEMPLATE_START_FAILED_EVENT, {
      ...logEntry,
      settlement: 'failed',
      ...generationStartDiagnostic(settlementError),
    });
  }
}

/**
 * Hold an ambiguous submission instead of refunding it.
 *
 * Task creation times out at 30s with no retry, so a timeout leaves
 * `predictionId` undefined exactly as a definitive provider rejection does --
 * but Kie may have accepted the task. Refunding here loses the money twice:
 * once on the refund, and again on the output the provider will still bill for
 * and whose callback we would then discard as already-settled.
 *
 * Holding needs no new recovery mechanism, because the row keeps the shape both
 * existing paths already match. A callback attaches through
 * `attach_generation_provider_task` and rescues the generation; if none arrives,
 * `reapStalledGenerations` settles it after its 45-minute window. That window is
 * deliberately the *only* clock on this row -- a second timer would give one
 * credit hold two owners racing to write the terminal state.
 */
type AmbiguousSubmissionHold =
  /** Held or already running: skip the refund, and the credits really are reserved. */
  | 'reserved'
  /** Something else already settled this row: skip the refund, but say nothing about reserved credits. */
  | 'settled'
  /** The hold could not be recorded; fall back to the pre-existing refund. */
  | 'unrecorded';

async function holdAmbiguousGenerationSubmission(params: {
  creditSupabase: SupabaseClient;
  generationId: string;
  userId: string;
  cost: number;
}): Promise<AmbiguousSubmissionHold> {
  try {
    const { data, error } = await params.creditSupabase.rpc('mark_generation_submission_unknown', {
      p_generation_id: params.generationId,
    });
    const status = data && typeof data === 'object' && 'status' in data
      ? String((data as { status?: unknown }).status)
      : null;

    // `provider_task_attached` means the callback beat this write -- the
    // provider had 30 seconds to accept and call back while we were still
    // waiting. That generation is running, so its credits are genuinely spent
    // on live work, which is what the reserved-credits copy describes.
    if (!error && (status === 'held' || status === 'already_marked' || status === 'provider_task_attached')) {
      logBackendWarning('generation_submission_unknown_held', {
        generationId: params.generationId,
        userId: params.userId,
        cost: params.cost,
        mark: status,
      });
      return 'reserved';
    }

    // Already settled by some other path. Refunding again would be wrong, but
    // so would telling the user their credits are reserved -- they may have
    // just been returned.
    if (!error && status === 'already_settled') {
      logBackendWarning('generation_submission_unknown_superseded', {
        generationId: params.generationId,
        mark: status,
      });
      return 'settled';
    }

    // Fall through to the refund only when the hold could not be recorded at
    // all. An unmarked held row is invisible to reconciliation, so the
    // pre-existing behaviour is the safer residual.
    logBackendError('generation_submission_unknown_mark_failed', {
      generationId: params.generationId,
      markStatus: status,
      error: supabaseErrorMessage(error, 'Unexpected submission-unknown mark status.'),
    });
    return 'unrecorded';
  } catch (markError) {
    logBackendError('generation_submission_unknown_mark_failed', {
      generationId: params.generationId,
      error: supabaseErrorMessage(markError, 'Failed to mark an ambiguous provider submission.'),
    });
    return 'unrecorded';
  }
}

async function settleGenerationStartFailureQuietly(params: {
  creditSupabase: SupabaseClient;
  error: unknown;
  generationId: string;
  userId: string;
  cost: number;
}) {
  // Only the ambiguous class is held. A provider that answered -- with an HTTP
  // error or a non-200 body code -- has definitively rejected the request, and
  // refunding it immediately stays correct.
  if (
    params.error instanceof AmbiguousProviderSubmissionError
    || isExternalServiceTimeoutError(params.error)
    || isExternalServiceNetworkError(params.error)
  ) {
    const hold = await holdAmbiguousGenerationSubmission({
      creditSupabase: params.creditSupabase,
      generationId: params.generationId,
      userId: params.userId,
      cost: params.cost,
    });

    if (hold !== 'unrecorded') {
      // Tagged only when the credits really are still reserved, so the copy the
      // caller renders can say so without the risk of promising it to someone
      // who has already been refunded.
      if (hold === 'reserved') markHeldProviderSubmission(params.error, params.generationId);
      return;
    }
  }

  const failure = getPublicGenerationStartFailure(params.error);
  try {
    // The atomic settlement RPC is deployed everywhere; it refunds and marks
    // the generation in one statement, so no manual refund fallback remains.
    const { data, error } = await params.creditSupabase.rpc('settle_generation_start_failed', {
      p_generation_id: params.generationId,
      p_error_message: failure.message,
    });
    const status = data && typeof data === 'object' && 'status' in data
      ? (data as { status?: unknown }).status
      : null;

    if (!error && (status === 'failed' || status === 'already_failed')) return;

    logBackendError('generation_start_failure_settlement_failed', {
      generationId: params.generationId,
      settlementStatus: status,
      error: supabaseErrorMessage(error, 'Unexpected generation start settlement status.'),
    });
  } catch (settlementError) {
    logBackendError('generation_start_failure_settlement_failed', {
      generationId: params.generationId,
      error: supabaseErrorMessage(settlementError, 'Failed to settle generation start failure.'),
    });
  }
}

// Generous ceiling above every supported model's accepted prompt size; it only
// exists to stop unbounded payloads from reaching the provider and database.
const GENERATION_PROMPT_MAX_LENGTH = 10000;

function trimPrompt(prompt: string, errorMessage: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new GenerationServiceError(errorMessage, 400);
  }

  if (trimmed.length > GENERATION_PROMPT_MAX_LENGTH) {
    throw new GenerationServiceError(
      `Prompts support up to ${GENERATION_PROMPT_MAX_LENGTH} characters.`,
      400
    );
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

const KLING_SUBJECT_MIN_IMAGES = 2;
const KLING_SUBJECT_MAX_IMAGES = 4;
const KLING_SUBJECT_MAX_COUNT = 3;

function normalizeKlingSubjectInputs(value: KlingSubjectInput[] | undefined) {
  const usedHandles = new Set<string>();

  return (value || [])
    .map((subject, index) => {
      if (!subject || typeof subject !== 'object') {
        return null;
      }

      const images = Array.isArray(subject.images)
        ? subject.images
          .map((image) => ({
            url: typeof image?.url === 'string' ? image.url.trim() : '',
            storagePath: typeof image?.storagePath === 'string' ? image.storagePath : null,
          }))
          .filter((image) => image.url.length > 0)
        : [];
      if (images.length === 0) {
        return null;
      }

      const displayName = normalizeElementDisplayName(
        typeof subject.displayName === 'string' ? subject.displayName : undefined,
        index + 1
      );
      const normalizedHandle = normalizeReferenceHandle(subject.handle);
      const handle = normalizedHandle && !usedHandles.has(normalizedHandle)
        ? normalizedHandle
        : buildElementHandle(displayName, usedHandles, index + 1);

      if (normalizedHandle && handle === normalizedHandle) {
        usedHandles.add(handle);
      }

      const description = typeof subject.description === 'string' && subject.description.trim()
        ? subject.description.trim()
        : displayName;

      return {
        id: typeof subject.id === 'string' && subject.id.trim() ? subject.id : null,
        handle,
        displayName,
        description,
        images,
      };
    })
    .filter((subject): subject is {
      id: string | null;
      handle: string;
      displayName: string;
      description: string;
      images: Array<{ url: string; storagePath: string | null }>;
    } => Boolean(subject));
}

// Seedance/Kling reference slots accept provider-issued asset handles instead
// of URLs. These opaque tokens contain no scheme or path separators, so they
// cannot address a network host.
const PROVIDER_ASSET_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function getConfiguredSupabaseOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

/**
 * Guards every media reference forwarded to the paid generation provider.
 * Allowed shapes:
 * - storage paths and Supabase storage-object URLs (resolved via own storage),
 * - `uploads/` and private template storage paths,
 * - URLs on the app's own Supabase origin (signed upload URLs),
 * - remote URLs whose host passes the media-import allowlist,
 * - bare provider asset handles (Seedance/Kling reference ids).
 * Anything else — arbitrary third-party URLs in particular — is rejected.
 */
function isAllowedGenerationMediaSource(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  if (getCanonicalStoredMediaLocation(trimmed)) return true;
  if (getCanonicalStoredMediaLocation(trimmed, {
    allowedBuckets: ['template_inputs', 'template_assets'],
  })) return true;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      if (new URL(trimmed).origin === getConfiguredSupabaseOrigin()) return true;
    } catch {
      return false;
    }
    return isAllowlistedRemoteMediaUrl(trimmed);
  }

  return PROVIDER_ASSET_HANDLE_PATTERN.test(trimmed);
}

function assertAllowedGenerationMediaSource(value: string): string {
  if (!isAllowedGenerationMediaSource(value)) {
    throw new GenerationServiceError(
      'Media references must come from your uploads, your generations, or a supported media source.',
      400
    );
  }

  return value;
}

async function resolveGenerationMediaSource(
  supabase: SupabaseClient,
  url: string,
  userId: string,
  options: {
    templateAssetScope?: {
      templateId: string;
      templateVersionId: string | null;
    };
  } = {},
): Promise<string> {
  const source = assertAllowedGenerationMediaSource(url);

  // Provider asset handles are opaque identifiers, not storage paths or URLs.
  if (PROVIDER_ASSET_HANDLE_PATTERN.test(source)) return source;

  const templateAsset = getCanonicalStoredMediaLocation(source, {
    allowedBuckets: ['template_assets'],
  });
  if (templateAsset) {
    const scope = options.templateAssetScope;
    if (!scope) {
      throw new GenerationServiceError(
        'Template catalog assets can only be used by a template run.',
        400,
      );
    }
    const requiredPrefix = scope.templateVersionId
      ? `${scope.templateId}/${scope.templateVersionId}/`
      : `${scope.templateId}/`;
    if (!templateAsset.filePath.startsWith(requiredPrefix)) {
      throw new GenerationServiceError(
        'Template media references must belong to the active template version.',
        400,
      );
    }
    const { data, error } = await supabase.storage
      .from(templateAsset.bucket)
      .createSignedUrl(templateAsset.filePath, 3600);
    if (error || !data?.signedUrl) {
      throw new GenerationServiceError('Failed to resolve the template media reference.', 500);
    }
    return data.signedUrl;
  }

  const resolved = await resolveOwnedStoredMediaUrl(supabase, source, userId);
  if (!resolved) {
    // A remix (or an unlocked recipe) hands the caller the original creator's
    // shared input media, whose path fails the ownership check above. Import a
    // caller-owned copy when that sharing is authorized — decided server-side
    // from the storage path, never from the client's signed URL.
    const imported = await importSharedGenerationInputMedia({
      source,
      viewerUserId: userId,
    });
    if (imported.outcome === 'imported') {
      return imported.signedUrl;
    }
    if (imported.outcome === 'failed') {
      throw new GenerationServiceError(
        'We could not prepare the shared reference media. Please try again.',
        500,
      );
    }
    throw new GenerationServiceError(
      'Media references must belong to the authenticated user.',
      400,
    );
  }
  return resolved;
}

async function resolveMediaUrls(
  supabase: SupabaseClient,
  urls: string[],
  userId: string,
  options: {
    templateAssetScope?: {
      templateId: string;
      templateVersionId: string | null;
    };
  } = {},
): Promise<string[]> {
  return Promise.all(urls.map((url) => resolveGenerationMediaSource(
    supabase,
    url,
    userId,
    options,
  )));
}

function templateAssetScope(
  context: TemplateGenerationContext | undefined,
): { templateId: string; templateVersionId: string | null } | undefined {
  return context?.templateId
    ? {
        templateId: context.templateId,
        templateVersionId: context.templateVersionId ?? null,
      }
    : undefined;
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

export function getStoredWorkflowModel(workflowSettings: Record<string, unknown> | null, fallbackModel: string): string {
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

export function getFirstResultUrl(value: unknown): string | null {
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

function getRemoteMediaKindForBucket(
  bucket: ReturnType<typeof getStorageBucket>,
): RemoteMediaKind {
  if (bucket === 'generated_images') return 'image';
  if (bucket === 'generated_audio') return 'audio';
  return 'video';
}

/**
 * Map an app image model id to the provider model id Kie expects.
 *
 * Exported for testing: this function decides which model the provider bills
 * for, so a wrong mapping either fails the generation outright or spends
 * credits on the wrong model. It is a pure function, so pinning it directly is
 * far cheaper than asserting it through a full start path.
 */
export function getKieImageModelId(model: ImageModelId, referenceCount: number): string {
  if (model === 'grok-imagine-image') {
    return referenceCount > 0 ? 'grok-imagine/image-to-image' : 'grok-imagine/text-to-image';
  }

  if (model === 'gpt-image-2') {
    return referenceCount > 0 ? 'gpt-image-2-image-to-image' : 'gpt-image-2-text-to-image';
  }

  if (model === 'seedream-5-pro') {
    return referenceCount > 0 ? 'seedream/5-pro-image-to-image' : 'seedream/5-pro-text-to-image';
  }

  if (model === 'seedream-5-lite') {
    return referenceCount > 0 ? 'seedream/5-lite-image-to-image' : 'seedream/5-lite-text-to-image';
  }

  if (model === 'imagen-4-fast') return 'google/imagen4-fast';
  if (model === 'imagen-4') return 'google/imagen4';
  if (model === 'imagen-4-ultra') return 'google/imagen4-ultra';
  if (model === 'ideogram-v3') {
    return referenceCount > 0 ? 'ideogram/v3-remix' : 'ideogram/v3-text-to-image';
  }

  if (model === 'flux-2-pro') {
    return referenceCount > 0 ? 'flux-2/pro-image-to-image' : 'flux-2/pro-text-to-image';
  }

  // Wan publishes its image models under a slashed, dash-separated id
  // (`wan/2-7-image`), not the dotted app id. Kie's OpenAPI spec declares that
  // string as the *sole* allowed enum value for the model parameter, so the
  // fallthrough below — which sends the app id verbatim — produces a request
  // the provider rejects. Verified 2026-07-25 against
  // https://docs.kie.ai/market/wan/2-7-image.md and .../2-7-image-pro.md.
  if (model === 'wan-2.7-image') return 'wan/2-7-image';
  if (model === 'wan-2.7-image-pro') return 'wan/2-7-image-pro';

  // Grok Imagine 2.0 also publishes an `image-edit` endpoint, but it edits a prior
  // Kie task by id rather than an uploaded image, so references never select it.
  if (model === 'grok-imagine-image-2') return 'grok-imagine-image-2-0/text-to-image';

  if (model === 'qwen3') {
    return referenceCount > 0 ? 'qwen3/image-to-image' : 'qwen3/text-to-image';
  }

  // Qwen's Pro tier is documented under market/qwen3-pro/* but the model enum nests
  // it inside the qwen3 vendor namespace. Verified 2026-08-15 against
  // https://docs.kie.ai/market/qwen3-pro/text-to-image.md and .../image-to-image.md.
  if (model === 'qwen3-pro') {
    return referenceCount > 0 ? 'qwen3/pro-image-to-image' : 'qwen3/pro-text-to-image';
  }

  // Character references are mandatory, so both admission modes hit the same endpoint.
  if (model === 'ideogram-character') return 'ideogram/character';

  // Everything else sends the app id unchanged, which is correct only because
  // those ids are byte-identical to the provider's (nano-banana-2,
  // nano-banana-2-lite, nano-banana-pro, z-image). Adding a model whose
  // provider id differs requires an explicit case above.
  return model;
}

/**
 * Ideogram's server-side Magic Prompt (expand_prompt) rewrites the prompt again
 * after our enhancer. That double rewrite is the main threat to exact-typography
 * jobs, and Ideogram's own docs recommend manual prompts for production
 * precision — so expansion is disabled whenever the prompt quotes literal text.
 */
export function promptLocksExactText(prompt: string): boolean {
  return /["“][^"“”]{1,}["”]/.test(prompt);
}

/** Condensed from Wan's open-weights default negative prompt (shared_config.py). */
export const WAN_VIDEO_DEFAULT_NEGATIVE_PROMPT =
  'blurry, low quality, overexposed, garish tones, gray cast, JPEG artifacts, static, still frame, '
  + 'flicker, unnatural movement, distorted faces, badly drawn hands, fused fingers, extra limbs, '
  + 'deformed body, subtitles, text, watermark, cluttered background, crowded background';

function getIdeogramImageSize(aspectRatio: string): string {
  return ({
    '1:1': 'square_hd',
    '4:3': 'landscape_4_3',
    '3:4': 'portrait_4_3',
    '16:9': 'landscape_16_9',
    '9:16': 'portrait_16_9',
  } as Record<string, string>)[aspectRatio] ?? 'square_hd';
}

async function createGenerationPreviewQuietly({
  body,
  filePath,
  category,
  contentType,
  storagePath,
  supabase,
}: {
  body?: Blob;
  filePath?: string;
  category: string | null | undefined;
  contentType: string | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  try {
    const resolvedContentType = contentType || body?.type || null;
    const preview = category === 'image' || resolvedContentType?.startsWith('image/')
      ? await import('@/lib/generation-media-preview').then((previewModule) => (
        filePath
          ? previewModule.createGenerationImagePreviewFromFile({ filePath, storagePath, supabase })
          : body
            ? previewModule.createGenerationImagePreview({ body, storagePath, supabase })
            : null
      ))
      : category === 'video' || category === 'motion' || resolvedContentType?.startsWith('video/')
        ? await import('@/lib/generation-video-preview').then((previewModule) => (
          filePath
            ? previewModule.createGenerationVideoPosterFromFile({ filePath, storagePath, supabase })
            : body
              ? previewModule.createGenerationVideoPoster({ body, storagePath, supabase })
              : null
        ))
        : null;
    return {
      previewUrl: preview?.previewStoragePath ?? null,
      previewThumbhash: preview?.previewThumbhash ?? null,
      previewStatus: preview ? 'ready' as const : 'failed' as const,
      previewError: preview ? null : 'Unsupported or invalid visual media.',
    };
  } catch (error) {
    logBackendError('generation_preview_poster_failed', { error });
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

  return category === 'image' || contentType?.startsWith('image/') ? outputUrl : null;
}

export async function persistGeneratedOutput(
  supabase: SupabaseClient,
  settlementSupabase: SupabaseClient,
  generation: SyncableGenerationRecord,
  tempUrl: string,
  completedAt?: string | null
): Promise<GenerationTerminalSettlementStatus> {
  const bucket = getStorageBucket(generation.category, generation.model);
  const settledAt = completedAt ?? new Date().toISOString();

  try {
    const stagedMedia = await stageAllowlistedRemoteMedia({
      url: tempUrl,
      kind: getRemoteMediaKindForBucket(bucket),
    });
    try {
      const extension = inferOutputExtension(
        stagedMedia.sourceName,
        stagedMedia.contentType,
        generation.category,
      );
      const fileName = `${generation.user_id}/generated_${generation.prediction_id}.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(fileName, createReadStream(stagedMedia.filePath), {
          contentType: stagedMedia.contentType || undefined,
          upsert: true,
        });

      if (uploadError) {
        logBackendError('generation_output_upload_failed', { predictionId: generation.prediction_id, error: uploadError });
        throw uploadError;
      }

      const storagePath = `${bucket}/${fileName}`;
      const preview = await createGenerationPreviewQuietly({
        filePath: stagedMedia.filePath,
        category: generation.category,
        contentType: stagedMedia.contentType,
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
    } finally {
      await stagedMedia.cleanup().catch((cleanupError) => {
        logBackendError('generation_staged_output_cleanup_failed', { predictionId: generation.prediction_id, error: cleanupError });
      });
    }
  } catch (error) {
    logBackendError('generation_output_persist_failed', { predictionId: generation.prediction_id, error });
    throw error;
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
      const stagedMedia = await stageAllowlistedRemoteMedia({
        url: tempUrl,
        kind: getRemoteMediaKindForBucket(bucket),
      });
      try {
        const extension = inferOutputExtension(
          stagedMedia.sourceName,
          stagedMedia.contentType,
          generation.category,
        );
        const suffix = tempUrls.length > 1 ? `_${index}` : '';
        const fileName = `${generation.user_id}/generated_${generation.prediction_id}${suffix}.${extension}`;

        const { error: uploadError } = await supabase.storage
          .from(bucket)
          .upload(fileName, createReadStream(stagedMedia.filePath), {
            contentType: stagedMedia.contentType || undefined,
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
            filePath: stagedMedia.filePath,
            category: generation.category,
            contentType: stagedMedia.contentType,
            storagePath: `${bucket}/${fileName}`,
            supabase,
          });
        }
      } finally {
        await stagedMedia.cleanup().catch((cleanupError) => {
          logBackendError('generation_staged_output_cleanup_failed', { predictionId: generation.prediction_id, outputIndex: index, error: cleanupError });
        });
      }
    } catch (error) {
      logBackendError('generation_output_persist_failed', { predictionId: generation.prediction_id, outputIndex: index, error });
      if (index === 0) {
        primaryPreview = {
          previewUrl: null,
          previewThumbhash: null,
          previewStatus: 'failed',
          previewError: error instanceof Error ? error.message.slice(0, 500) : 'Preview generation failed.',
        };
      }
    }
  }

  if (outputs.length !== tempUrls.length || !outputs.some((output) => output.index === 0)) {
    throw new Error(
      `Persisted ${outputs.length} of ${tempUrls.length} provider outputs; settlement deferred for retry.`,
    );
  }

  const primaryOutput = outputs.find((output) => output.index === 0)?.storagePath ?? null;
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
  persistInputMedia?: boolean;
  privateRecipe?: boolean;
  templateContext?: TemplateGenerationContext;
  quotedCostCredits?: number;
  operationalConfig?: GenerationModelOperationalConfig;
  catalogRevision?: string;
  sourceGenerationId?: string | null;
}): Promise<GenerationStartResult> {
  requireKieGenerationConfiguration();
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
    persistInputMedia = true,
    privateRecipe = false,
    templateContext,
    quotedCostCredits,
    operationalConfig,
    catalogRevision,
    sourceGenerationId = null,
  } = params;

  if (templateContext && !privateRecipe) {
    throw new GenerationServiceError('Template generations must keep their recipe private.', 500);
  }

  const trimmedPrompt = trimPrompt(prompt, 'A prompt is required to generate an image.');
  const modelConfig = IMAGE_MODELS[model];
  if (!modelConfig) {
    throw new GenerationServiceError(`Unsupported image model: ${model}`, 400);
  }
  const aspectRatio = requestedAspectRatio ?? modelConfig.aspectRatios[0];

  assertGenerationRequest(
    (modelConfig.aspectRatios as readonly string[]).includes(aspectRatio),
    `${modelConfig.displayName} does not support aspect ratio ${aspectRatio}.`
  );

  assertGenerationRequest(
    isValidImageResolution(model, resolution, aspectRatio),
    `${modelConfig.displayName} supports ${getImageResolutionOptions(model, aspectRatio).join(', ')} at aspect ratio ${aspectRatio}.`
  );

  if (model === 'grok-imagine-image' || model === 'ideogram-v3') {
    assertGenerationRequest(
      isValidImageQualityMode(qualityMode),
      `Unsupported quality mode for ${modelConfig.displayName}.`
    );
  }

  if (model === 'ideogram-v3') {
    assertGenerationRequest(
      qualityMode === 'turbo' || qualityMode === 'balanced' || qualityMode === 'quality',
      'Ideogram V3 supports Turbo, Balanced, or Quality speed.'
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
      : normalizeMediaUrlList(imageUrls),
    userId,
    { templateAssetScope: templateAssetScope(templateContext) },
  );

  assertGenerationRequest(
    normalizedElements.length <= resolvedImageUrls.length,
    'Element metadata does not match the uploaded element images.'
  );

  assertGenerationRequest(
    resolvedImageUrls.length <= modelConfig.maxImages,
    `${modelConfig.displayName} supports up to ${modelConfig.maxImages} total reference images.`
  );

  if (model === 'wan-2.7-image-pro' && resolution === '4K' && resolvedImageUrls.length > 0) {
    throw new GenerationServiceError('Wan 2.7 Image Pro supports 4K for text-to-image only.', 400);
  }

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
  const runtimeConfig = operationalConfig
    ?? await loadGenerationModelOperationalConfig(model, catalogRevision
      ? { catalogRevision, schemaVersion: 1 }
      : undefined);

  // Declaratively-adapted models skip the hand-coded payload ladder entirely:
  // the adapterConfig in the model's operational config builds the provider
  // request, and startCatalogGeneration owns reservation/settlement. Because
  // this keys off the *loaded* config, production only takes this path once a
  // catalog release flips the model's adapterKey — the ladder below stays as
  // the deployment-window fallback until then. All validation above (aspect
  // ratio, resolution, reference caps, element handles) has already run.
  if (runtimeConfig?.adapterKey === 'kie-task-v1') {
    const referenceSources = normalizedReferences.length > 0
      ? normalizedReferences
      : normalizeMediaUrlList(imageUrls).map((url) => ({
          url,
          displayName: null,
          handle: null,
          storagePath: null,
          sourceGenerationId: null,
        }));
    return startCatalogGeneration({
      supabase,
      creditSupabase,
      userId,
      clientRequestKeyHash,
      operation: runtimeConfig,
      catalogRevision: catalogRevision ?? 'code',
      prompt: compiledPrompt,
      settings: {
        aspectRatio,
        resolution,
        outputFormat,
        googleSearch,
      },
      // resolvedImageUrls already went through resolveGenerationMediaSource as
      // part of validation above, so they are passed pre-resolved; the source
      // arrays share order, letting element metadata align by index. Element
      // descriptors carry the storage identity when references arrive as bare
      // urls (the imageUrls path) — dropping them broke input snapshotting and
      // remix lineage for element-driven generations.
      inputs: referenceSources.map((reference, index) => ({
        slot: 'imageReferences',
        kind: 'image' as const,
        url: resolvedImageUrls[index] ?? reference.url,
        label: normalizedElements[index]?.displayName ?? reference.displayName ?? null,
        handle: normalizedElements[index]?.handle ?? reference.handle ?? null,
        elementId: normalizedElements[index]?.id ?? null,
        storagePath: normalizedElements[index]?.storagePath ?? reference.storagePath ?? null,
        sourceGenerationId: normalizedElements[index]?.sourceGenerationId
          ?? reference.sourceGenerationId
          ?? null,
      })),
      inputsPreResolved: true,
      quotedCostCredits: cost,
      sourceGenerationId,
      persistInputMedia,
      privateRecipe,
      templateContext,
    });
  }

  const providerModel = resolveProviderModelId(
    runtimeConfig,
    resolvedImageUrls.length > 0 ? 'reference' : 'text',
    getKieImageModelId(model, resolvedImageUrls.length),
  );

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
    } else if (model === 'nano-banana-2-lite') {
      input = {
        prompt: compiledPrompt,
        aspect_ratio: aspectRatio,
      };

      if (resolvedImageUrls.length > 0) {
        input.image_urls = resolvedImageUrls;
      }
    } else if (model === 'seedream-5-pro') {
      input = {
        prompt: compiledPrompt,
        aspect_ratio: aspectRatio,
        quality: resolution === '2K' ? 'high' : 'basic',
        output_format: outputFormat === 'jpg' ? 'jpeg' : outputFormat,
        nsfw_checker: true,
      };

      if (resolvedImageUrls.length > 0) {
        input.image_urls = resolvedImageUrls;
      }
    } else if (model === 'seedream-5-lite') {
      input = {
        prompt: compiledPrompt,
        aspect_ratio: aspectRatio,
        quality: resolution === '3K' ? 'high' : 'basic',
        output_format: outputFormat === 'jpg' ? 'jpeg' : outputFormat,
        nsfw_checker: true,
      };
      if (resolvedImageUrls.length > 0) input.image_urls = resolvedImageUrls;
    } else if (model === 'wan-2.7-image' || model === 'wan-2.7-image-pro') {
      input = {
        prompt: compiledPrompt,
        n: 1,
        enable_sequential: false,
        resolution,
        thinking_mode: false,
        watermark: false,
      };
      // Both keys are edit-mode only. Sending them empty on a text-to-image
      // request makes the provider reject it with "bbox_list requires
      // input_urls" — an empty bbox_list still reads as an edit intent.
      if (resolvedImageUrls.length > 0) {
        input.input_urls = resolvedImageUrls;
        input.bbox_list = resolvedImageUrls.map(() => []);
      }
    } else if (model === 'imagen-4-fast' || model === 'imagen-4' || model === 'imagen-4-ultra') {
      input = { prompt: compiledPrompt, aspect_ratio: aspectRatio };
    } else if (model === 'ideogram-v3') {
      input = {
        prompt: compiledPrompt,
        rendering_speed: qualityMode.toUpperCase(),
        style: 'AUTO',
        expand_prompt: !promptLocksExactText(compiledPrompt),
        image_size: getIdeogramImageSize(aspectRatio),
      };
      if (resolvedImageUrls[0]) {
        input.image_url = resolvedImageUrls[0];
        input.num_images = 1;
        input.strength = 0.6;
      }
    } else if (model === 'flux-2-pro') {
      input = {
        prompt: compiledPrompt,
        aspect_ratio: aspectRatio,
        resolution,
        nsfw_checker: true,
      };

      if (resolvedImageUrls.length > 0) {
        input.input_urls = resolvedImageUrls;
      }
    } else if (model === 'grok-imagine-image-2') {
      // Text-to-image only: the provider's edit endpoint keys off a prior task id,
      // so references never reach this model.
      input = {
        prompt: compiledPrompt,
        aspect_ratio: aspectRatio,
      };
    } else if (model === 'qwen3' || model === 'qwen3-pro') {
      input = {
        prompt: compiledPrompt,
        resolution,
        image_size: aspectRatio,
        output_format: outputFormat === 'jpg' ? 'jpeg' : outputFormat,
        prompt_extend: true,
        nsfw_checker: true,
      };

      if (resolvedImageUrls.length > 0) {
        input.image_urls = resolvedImageUrls;
      }
    } else if (model === 'ideogram-character') {
      // The provider requires at least one character reference; validation rejects
      // the request before we get here if none were supplied.
      input = {
        prompt: compiledPrompt,
        rendering_speed: qualityMode.toUpperCase(),
        style: 'AUTO',
        expand_prompt: !promptLocksExactText(compiledPrompt),
        image_size: getIdeogramImageSize(aspectRatio),
        reference_image_urls: resolvedImageUrls,
        num_images: 1,
      };
    } else if (model === 'z-image') {
      input = {
        prompt: compiledPrompt,
        aspect_ratio: aspectRatio,
        nsfw_checker: true,
      };
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
      prompt: privateRecipe ? null : trimmedPrompt,
      category: 'image',
      source_generation_id: sourceGenerationId,
      workflow_settings: privateRecipe ? {} : {
        model,
        ...(catalogRevision ? { catalogRevision } : {}),
        aspectRatio,
        resolution,
        ...(model === 'grok-imagine-image' || model === 'ideogram-v3' ? { qualityMode } : {}),
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
    }, templateContext);
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

    predictionId = await createKieTask({ model: providerModel, input }, undefined, { generationId, modelId: model });
    await markGenerationProviderStarted(creditSupabase, generationId, predictionId);

    if (persistInputMedia) {
      await persistGenerationInputMedia({
        supabase: creditSupabase,
        generationId,
        userId,
        candidates: collectImageInputCandidates({
          resolvedImageUrls,
          elements: normalizedElements,
        }),
      });
    }

    return {
      predictionId,
      remainingCredits: reservation.remainingCredits,
      cost: reservation.cost,
      generationId,
    };
  } catch (error) {
    if (!predictionId && generationId) {
      if (templateContext) {
        await settleTemplateGenerationStartFailureQuietly({
          creditSupabase,
          error,
          generationId,
          model,
          templateContext,
          userId,
          cost,
        });
      } else {
        await settleGenerationStartFailureQuietly({
          creditSupabase,
          error,
          generationId,
          userId,
          cost,
        });
      }
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
  preparedAudioIds?: string[];
  characterIds?: string[];
  klingVideoElements?: KlingVideoElementInput[];
  klingSubjects?: KlingSubjectInput[];
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
  operationalConfig?: GenerationModelOperationalConfig;
  catalogRevision?: string;
  sourceGenerationId?: string | null;
  persistInputMedia?: boolean;
  privateRecipe?: boolean;
  templateContext?: TemplateGenerationContext;
}): Promise<GenerationStartResult> {
  requireKieGenerationConfiguration();
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
    preparedAudioIds = [],
    characterIds = [],
    klingVideoElements = [],
    klingSubjects = [],
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
    operationalConfig,
    catalogRevision,
    sourceGenerationId = null,
    persistInputMedia = true,
    privateRecipe = false,
    templateContext,
  } = params;

  if (templateContext && !privateRecipe) {
    throw new GenerationServiceError('Template generations must keep their recipe private.', 500);
  }

  const selectedModel = VIDEO_MODELS[model];
  if (!selectedModel) {
    throw new GenerationServiceError(`Unsupported video model: ${model}`, 400);
  }
  const runtimeConfig = operationalConfig
    ?? await loadGenerationModelOperationalConfig(model, catalogRevision
      ? { catalogRevision, schemaVersion: 1 }
      : undefined);

  const rawPrompt = typeof prompt === 'string' ? prompt : '';
  const trimmedPrompt = rawPrompt.trim();
  const normalizedReferences = normalizeReferenceImageInputs(references);
  const normalizedKlingVideoElements = normalizeKlingVideoElementInputs(klingVideoElements);
  const normalizedKlingSubjects = normalizeKlingSubjectInputs(klingSubjects);
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
  const combinesFrameWithReferences = model === 'wan-2.7' && normalizedReferenceMode === 'elements';
  const useLegacyFrameUrls = normalizedReferences.length === 0 && !combinesFrameWithReferences && (
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
  // minimax-h3's provider branch consumes reference_video_urls/reference_audio_urls, so
  // omitting it here silently discarded every clip and track the user attached.
  const supportsMultimodalReferences = isSeedance2Family
    || model === 'wan-2.7'
    || model === 'gemini-omni-video'
    || model === 'minimax-h3';
  const resolvedReferenceImageUrls = normalizedReferences.length > 0
    ? await resolveMediaUrls(
        supabase,
        normalizedReferences.map((reference) => reference.url),
        userId,
        { templateAssetScope: templateAssetScope(templateContext) },
      )
    : useLegacyFrameUrls
      ? []
      : await resolveMediaUrls(
          supabase,
          normalizeMediaUrlList(imageUrls),
          userId,
          { templateAssetScope: templateAssetScope(templateContext) },
        );
  const resolvedReferenceVideoUrls = supportsMultimodalReferences
    ? await resolveMediaUrls(
        supabase,
        normalizeMediaUrlList(referenceVideoUrls),
        userId,
        { templateAssetScope: templateAssetScope(templateContext) },
      )
    : [];
  const resolvedReferenceAudioUrls = supportsMultimodalReferences
    ? await resolveMediaUrls(
        supabase,
        normalizeMediaUrlList(referenceAudioUrls),
        userId,
        { templateAssetScope: templateAssetScope(templateContext) },
      )
    : [];
  const normalizedPreparedAudioIds = model === 'gemini-omni-video'
    ? Array.from(new Set(preparedAudioIds.map((value) => value.trim()).filter(Boolean)))
    : [];
  const normalizedCharacterIds = model === 'gemini-omni-video'
    ? Array.from(new Set(characterIds.map((value) => value.trim()).filter(Boolean)))
    : [];
  const resolvedKlingVideoElements = model === 'kling-3.0-video'
    ? await Promise.all(normalizedKlingVideoElements.map(async (element) => ({
        ...element,
        url: await resolveGenerationMediaSource(
          supabase,
          element.url,
          userId,
          { templateAssetScope: templateAssetScope(templateContext) },
        ),
      })))
    : [];
  const resolvedKlingSubjects = model === 'kling-o3'
    ? await Promise.all(normalizedKlingSubjects.map(async (subject) => ({
        ...subject,
        imageUrls: await Promise.all(subject.images.map((image) => resolveGenerationMediaSource(
          supabase,
          image.url,
          userId,
          { templateAssetScope: templateAssetScope(templateContext) },
        ))),
      })))
    : [];
  const resolvedElementImageUrls = normalizedReferences.length > 0
    ? resolvedReferenceImageUrls.filter((_url, index) => Boolean(normalizedReferences[index]?.handle))
    : await resolveMediaUrls(
        supabase,
        normalizeMediaUrlList(elementImageUrls),
        userId,
        { templateAssetScope: templateAssetScope(templateContext) },
      );
  const resolvedLegacyImageUrls = normalizedReferences.length > 0
    ? []
    : useLegacyFrameUrls
      ? await resolveMediaUrls(
          supabase,
          normalizeMediaUrlList(imageUrls),
          userId,
          { templateAssetScope: templateAssetScope(templateContext) },
        )
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

  if (isSeedance2Family && resolvedReferenceVideoUrls.length > 3) {
    throw new GenerationServiceError(
      'Seedance 2 supports up to 3 reference videos per run.',
      400
    );
  }

  if (isSeedance2Family && resolvedReferenceAudioUrls.length > 3) {
    throw new GenerationServiceError(
      'Seedance 2 supports up to 3 reference audio files per run.',
      400
    );
  }

  if (model === 'wan-2.7' && (
    resolvedReferenceImageUrls.length
    + resolvedReferenceVideoUrls.length
    + resolvedReferenceAudioUrls.length
  ) > 5) {
    throw new GenerationServiceError(
      'Wan 2.7 supports up to 5 reusable image, video, and audio references in total.',
      400
    );
  }

  if (model === 'wan-2.7' && resolvedReferenceAudioUrls.length > 1) {
    throw new GenerationServiceError('Wan 2.7 supports one reference voice per run.', 400);
  }

  if (model === 'gemini-omni-video' && resolvedReferenceVideoUrls.length > 1) {
    throw new GenerationServiceError('Gemini Omni supports one reference video per run.', 400);
  }

  if (model === 'gemini-omni-video' && resolvedReferenceImageUrls.length + (resolvedReferenceVideoUrls.length * 2) > 7) {
    throw new GenerationServiceError('Gemini Omni supports seven reference slots; a video uses two slots.', 400);
  }
  if (model === 'gemini-omni-video' && normalizedPreparedAudioIds.length > 3) {
    throw new GenerationServiceError('Gemini Omni supports up to 3 prepared voice references.', 400);
  }
  if (model === 'gemini-omni-video' && normalizedCharacterIds.length > 3) {
    throw new GenerationServiceError('Gemini Omni supports up to 3 prepared character references.', 400);
  }
  if (model === 'gemini-omni-video' && resolvedReferenceImageUrls.length + (resolvedReferenceVideoUrls.length * 2) + normalizedCharacterIds.length > 7) {
    throw new GenerationServiceError('Gemini Omni supports seven reference slots; videos use two and characters use one.', 400);
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

  if (normalizedKlingSubjects.length > 0 && model !== 'kling-o3') {
    throw new GenerationServiceError(
      'Named multi-image subjects are only available for Kling O3.',
      400
    );
  }

  if (resolvedKlingSubjects.length > KLING_SUBJECT_MAX_COUNT) {
    throw new GenerationServiceError(
      `Kling O3 supports up to ${KLING_SUBJECT_MAX_COUNT} named subjects per run.`,
      400
    );
  }

  for (const subject of resolvedKlingSubjects) {
    if (subject.imageUrls.length < KLING_SUBJECT_MIN_IMAGES || subject.imageUrls.length > KLING_SUBJECT_MAX_IMAGES) {
      throw new GenerationServiceError(
        `Each Kling O3 named subject needs ${KLING_SUBJECT_MIN_IMAGES} to ${KLING_SUBJECT_MAX_IMAGES} images (${subject.displayName} has ${subject.imageUrls.length}).`,
        400
      );
    }
  }

  if (resolvedKlingSubjects.length > 0 && (imageUrls.length > 0 || startImageUrl || endImageUrl || references?.length)) {
    // The provider allows mixing subjects with flat references under a combined
    // cap matrix; the app keeps the first release simple and unambiguous.
    throw new GenerationServiceError(
      'Kling O3 named subjects replace reference images and frames for this run.',
      400
    );
  }

  const resolvedStartImageUrl = startImageUrl
    ? await resolveGenerationMediaSource(
        supabase,
        startImageUrl,
        userId,
        { templateAssetScope: templateAssetScope(templateContext) },
      )
    : null;
  const resolvedEndImageUrl = endImageUrl
    ? await resolveGenerationMediaSource(
        supabase,
        endImageUrl,
        userId,
        { templateAssetScope: templateAssetScope(templateContext) },
      )
    : null;

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

  if (totalReferenceImageCount > 0 && frameImageUrls.length > 0 && !combinesFrameWithReferences) {
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

  if ((model === 'kling-3.0-turbo' || model === 'hailuo-2.3') && frameImageUrls.length > 1) {
    throw new GenerationServiceError(
      `${selectedModel.displayName} supports a start frame only.`,
      400
    );
  }

  if (model === 'hailuo-2.3' && frameImageUrls.length === 0) {
    throw new GenerationServiceError('Hailuo 2.3 requires a start image.', 400);
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
    ...resolvedKlingSubjects.map((subject) => subject.handle),
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
  if (isMultiShot && (model === 'kling-3.0-video' || model === 'kling-o3')) {
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
  const hasReusableReference = totalReferenceImageCount > 0
    || resolvedReferenceVideoUrls.length > 0
    || resolvedReferenceAudioUrls.length > 0
  ;
  const effectiveReferenceMode = hasReusableReference
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
  if (model === 'hailuo-2.3' && resolution === '1080P' && duration === 10) {
    throw new GenerationServiceError('Hailuo 2.3 supports 1080P output at 6 seconds only.', 400);
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
    hasReferenceImage: resolvedReferenceImageUrls.length > 0 || frameImageUrls.length > 0,
  });
  const cost = resolveQuotedGenerationCost(computedCost, quotedCostCredits);

  let generationId: string | null = null;
  let predictionId: string | null = null;
  try {
    let endpoint = 'https://api.kie.ai/api/v1/jobs/createTask';
    let body: Record<string, unknown>;
    let providerModelId = resolveProviderModelId(runtimeConfig, 'default', selectedModel.apiModelId || mode);
    const referenceImageUrls = resolvedReferenceImageUrls;
    const providerReferenceImageUrls = referenceImageUrls.length > 0
      ? referenceImageUrls
      : resolvedElementImageUrls;
    const requestedMode = mode;
    const providerMode = mode;

    if (model === 'kling-3.0-turbo') {
      const firstFrameUrl = frameImageUrls[0] || null;
      providerModelId = resolveProviderModelId(
        runtimeConfig,
        firstFrameUrl ? 'image' : 'text',
        firstFrameUrl ? 'kling/v3-turbo-image-to-video' : 'kling/v3-turbo-text-to-video',
      );
      // Kling v3 Turbo types `duration` as a string ('5'), where grok-imagine
      // types the same field as an integer. Every other Kling branch already
      // sends String(...); this one passed the raw number straight through.
      const input: Record<string, unknown> = {
        prompt: compiledPrompt,
        duration: String(duration),
        resolution,
      };
      if (firstFrameUrl) {
        input.image_urls = [firstFrameUrl];
      } else {
        input.aspect_ratio = aspectRatio;
      }
      body = { model: providerModelId, input };
    } else if (model === 'kling-o3') {
      // Kling O3 (3.0 Omni) renames the fields its 3.0 sibling uses: `audio` for
      // sound, `customize_multi_shots` for multi-shot, and an integer duration.
      const klingO3ImageUrls = providerReferenceImageUrls.length > 0
        ? providerReferenceImageUrls
        : frameImageUrls;
      providerModelId = resolveProviderModelId(
        runtimeConfig,
        providerReferenceImageUrls.length > 0
          ? 'reference'
          : (frameImageUrls.length > 0 ? 'image' : 'text'),
        providerReferenceImageUrls.length > 0
          ? 'kling-3.0-omni/reference-to-video'
          : (frameImageUrls.length > 0
            ? 'kling-3.0-omni/image-to-video'
            : 'kling-3.0-omni/text-to-video'),
      );

      const input: Record<string, unknown> = {
        prompt: compiledPrompt,
        resolution,
        aspect_ratio: aspectRatio,
        duration: totalDuration,
        audio: soundEnabled,
        customize_multi_shots: Boolean(isMultiShot),
      };

      if (isMultiShot) {
        input.multi_prompt = normalizedMultiPrompts.map((shot) => ({
          prompt: shot.prompt,
          duration: shot.duration,
        }));
      }

      if (klingO3ImageUrls.length > 0) {
        input.image_urls = klingO3ImageUrls;
      }

      if (resolvedKlingSubjects.length > 0) {
        // Multi-image named subjects, referenced in the prompt as @name.
        // Field shape live-verified 2026-08-24 (see the playbook doc).
        input.elements = resolvedKlingSubjects.map((subject) => ({
          name: subject.handle.replace(/^@/, ''),
          description: subject.description,
          element_input_urls: subject.imageUrls,
        }));
      }

      body = { model: providerModelId, input };
    } else if (selectedModel.provider === 'minimax') {
      const usesReferences = providerReferenceImageUrls.length > 0
        || resolvedReferenceVideoUrls.length > 0
        || resolvedReferenceAudioUrls.length > 0;
      providerModelId = resolveProviderModelId(
        runtimeConfig,
        usesReferences ? 'reference' : (frameImageUrls.length > 0 ? 'image' : 'text'),
        usesReferences
          ? 'minimax-h3/reference-to-video'
          : (frameImageUrls.length > 0 ? 'minimax-h3/image-to-video' : 'minimax-h3/text-to-video'),
      );

      const input: Record<string, unknown> = {
        prompt: compiledPrompt,
        duration,
        resolution,
      };

      if (usesReferences) {
        input.aspect_ratio = aspectRatio;
        if (providerReferenceImageUrls.length > 0) input.reference_image_urls = providerReferenceImageUrls;
        if (resolvedReferenceVideoUrls.length > 0) input.reference_video_urls = resolvedReferenceVideoUrls;
        if (resolvedReferenceAudioUrls.length > 0) input.reference_audio_urls = resolvedReferenceAudioUrls;
      } else if (frameImageUrls.length > 0) {
        if (frameImageUrls[0]) input.first_frame_url = frameImageUrls[0];
        if (frameImageUrls[1]) input.last_frame_url = frameImageUrls[1];
      } else {
        input.aspect_ratio = aspectRatio;
      }

      body = { model: providerModelId, input };
    } else if (selectedModel.provider === 'kling') {
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
        model: providerModelId,
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

        if (effectiveReferenceMode === 'frames') {
          if (frameImageUrls[0]) input.first_frame_url = frameImageUrls[0];
          if (frameImageUrls[1]) input.last_frame_url = frameImageUrls[1];
        } else {
          if (providerReferenceImageUrls.length > 0) {
            input.reference_image_urls = providerReferenceImageUrls;
          }
          if (resolvedReferenceVideoUrls.length > 0) {
            input.reference_video_urls = resolvedReferenceVideoUrls;
          }
          if (resolvedReferenceAudioUrls.length > 0) {
            input.reference_audio_urls = resolvedReferenceAudioUrls;
          }
        }

        body = {
          model: providerModelId,
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
          model: providerModelId,
          input,
        };
      }
    } else if (selectedModel.provider === 'wan') {
      const input: Record<string, unknown> = {
        prompt: compiledPrompt,
        resolution,
        duration,
        prompt_extend: true,
        // Condensed from the Wan reference implementation's default negative
        // stack — the hosted API does not apply one for you (≤500-char field).
        negative_prompt: WAN_VIDEO_DEFAULT_NEGATIVE_PROMPT,
        watermark: false,
      };
      if (effectiveReferenceMode === 'references') {
        providerModelId = resolveProviderModelId(runtimeConfig, 'reference', 'wan/2-7-r2v');
        input.aspect_ratio = aspectRatio;
        if (providerReferenceImageUrls.length > 0) input.reference_image = providerReferenceImageUrls;
        if (resolvedReferenceVideoUrls.length > 0) input.reference_video = resolvedReferenceVideoUrls;
        if (resolvedReferenceAudioUrls[0]) input.reference_voice = resolvedReferenceAudioUrls[0];
        if (frameImageUrls[0]) input.first_frame = frameImageUrls[0];
      } else if (frameImageUrls.length > 0) {
        providerModelId = resolveProviderModelId(runtimeConfig, 'image', 'wan/2-7-image-to-video');
        input.first_frame_url = frameImageUrls[0];
        if (frameImageUrls[1]) input.last_frame_url = frameImageUrls[1];
      } else {
        providerModelId = resolveProviderModelId(runtimeConfig, 'text', 'wan/2-7-text-to-video');
        input.ratio = aspectRatio;
      }
      body = { model: providerModelId, input };
    } else if (selectedModel.provider === 'happyhorse') {
      const input: Record<string, unknown> = {
        prompt: compiledPrompt,
        resolution,
        duration,
      };
      if (effectiveReferenceMode === 'references' && providerReferenceImageUrls.length > 0) {
        providerModelId = resolveProviderModelId(runtimeConfig, 'reference', 'happyhorse-1-1/reference-to-video');
        input.reference_image = providerReferenceImageUrls;
        input.aspect_ratio = aspectRatio;
      } else if (frameImageUrls[0]) {
        providerModelId = resolveProviderModelId(runtimeConfig, 'image', 'happyhorse-1-1/image-to-video');
        input.image_urls = [frameImageUrls[0]];
      } else {
        providerModelId = resolveProviderModelId(runtimeConfig, 'text', 'happyhorse-1-1/text-to-video');
        input.aspect_ratio = aspectRatio;
      }
      body = { model: providerModelId, input };
    } else if (selectedModel.provider === 'gemini-omni') {
      providerModelId = resolveProviderModelId(runtimeConfig, 'default', 'gemini-omni-video');
      const input: Record<string, unknown> = {
        prompt: compiledPrompt,
        image_urls: providerReferenceImageUrls,
        duration: String(duration),
        aspect_ratio: aspectRatio,
        resolution,
      };
      if (resolvedReferenceVideoUrls[0]) {
        input.video_list = [{ url: resolvedReferenceVideoUrls[0], start: 0, ends: duration }];
      }
      if (normalizedPreparedAudioIds.length > 0) input.audio_ids = normalizedPreparedAudioIds;
      if (normalizedCharacterIds.length > 0) input.character_ids = normalizedCharacterIds;
      body = { model: providerModelId, input };
    } else if (selectedModel.provider === 'hailuo') {
      providerModelId = resolveProviderModelId(
        runtimeConfig,
        mode === 'pro' ? 'pro' : 'standard',
        mode === 'pro' ? 'hailuo/2-3-image-to-video-pro' : 'hailuo/2-3-image-to-video-standard',
      );
      body = {
        model: providerModelId,
        input: {
          prompt: compiledPrompt,
          image_url: frameImageUrls[0],
          duration: String(duration),
          resolution,
        },
      };
    } else if (selectedModel.provider === 'grok') {
      providerModelId = resolveProviderModelId(
        runtimeConfig,
        grokVideoImageUrls.length > 0 ? 'image' : 'text',
        grokVideoImageUrls.length > 0 ? 'grok-imagine/image-to-video' : 'grok-imagine/text-to-video',
      );

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
    } else if (selectedModel.provider === 'veo') {
      endpoint = 'https://api.kie.ai/api/v1/veo/generate';
      providerModelId = resolveProviderModelId(
        runtimeConfig,
        mode === 'veo3' || mode === 'veo3_lite' ? mode : 'veo3_fast',
        mode === 'veo3' || mode === 'veo3_lite' ? mode : 'veo3_fast',
      );
      // The veo endpoint names this field `aspect_ratio`, unlike its camelCase
      // neighbours (`imageUrls`, `generationType`, `callBackUrl`). Sending
      // `aspectRatio` meant veo never saw a ratio and silently fell back to its
      // 16:9 default, so the picker had no effect on the rendered video.
      // `resolution` (720p/1080p/4k) is a valid veo request field.
      // NOTE: model_api_references/veo-3-1.md is stale on both points — verify
      // against https://docs.kie.ai/veo3-api/generate-veo-3-video.md instead.
      body = {
        prompt: compiledPrompt,
        model: providerModelId,
        aspect_ratio: aspectRatio,
        resolution,
        generationType: referenceImageUrls.length > 0
          ? 'REFERENCE_2_VIDEO'
          : (frameImageUrls.length > 0 ? 'FIRST_AND_LAST_FRAMES_2_VIDEO' : 'TEXT_2_VIDEO'),
        ...(referenceImageUrls.length > 0
          ? { imageUrls: referenceImageUrls }
          : (frameImageUrls.length > 0 ? { imageUrls: frameImageUrls } : {})),
      };
    } else {
      // This ladder used to end in an implicit Veo fallthrough: any video model
      // without an explicit branch was silently ROUTED to the Veo endpoint and
      // generated on the wrong provider API. The `satisfies never` makes a new
      // provider a compile error here; the throw guards runtime casts.
      selectedModel satisfies never;
      throw new GenerationServiceError(
        `No provider payload branch for video model ${model}.`,
        500,
      );
    }

    const reservation = await startGenerationRecord(creditSupabase, {
      user_id: userId,
      model,
      cost,
      duration: totalDuration,
      client_request_key_hash: clientRequestKeyHash,
      prompt: privateRecipe ? null : (isMultiShot ? normalizedMultiPrompts[0]?.prompt || '' : trimmedPrompt),
      category: 'video',
      source_generation_id: sourceGenerationId,
      workflow_settings: privateRecipe ? {} : {
        model,
        ...(catalogRevision ? { catalogRevision } : {}),
        mode,
        ...(model === 'grok-imagine-video'
          ? {
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
        ...(providerReferenceImageUrls.length > 0
          ? { referenceImageUrls: providerReferenceImageUrls }
          : {}),
        ...(resolvedReferenceVideoUrls.length > 0
          ? { referenceVideoUrls: resolvedReferenceVideoUrls }
          : {}),
        ...(resolvedReferenceAudioUrls.length > 0
          ? { referenceAudioUrls: resolvedReferenceAudioUrls }
          : {}),
        ...(normalizedPreparedAudioIds.length > 0 ? { preparedAudioIds: normalizedPreparedAudioIds } : {}),
        ...(normalizedCharacterIds.length > 0 ? { characterIds: normalizedCharacterIds } : {}),
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
        ...((effectiveReferenceMode === 'frames' || model === 'wan-2.7') && normalizedStartFrame
          ? { startFrame: normalizedStartFrame }
          : {}),
        ...(effectiveReferenceMode === 'frames' && normalizedEndFrame
          ? { endFrame: normalizedEndFrame }
          : {}),
      },
    }, templateContext);
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

    predictionId = await createKieTask(body, endpoint, { generationId, modelId: model });
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

    if (persistInputMedia) {
      await persistGenerationInputMedia({
        supabase: creditSupabase,
        generationId,
        userId,
        candidates: videoInputCandidates,
      });
    }

    return {
      predictionId,
      remainingCredits: reservation.remainingCredits,
      cost: reservation.cost,
      generationId,
    };
  } catch (error) {
    if (!predictionId && generationId) {
      if (templateContext) {
        await settleTemplateGenerationStartFailureQuietly({
          creditSupabase,
          error,
          generationId,
          model,
          templateContext,
          userId,
          cost,
        });
      } else {
        await settleGenerationStartFailureQuietly({
          creditSupabase,
          error,
          generationId,
          userId,
          cost,
        });
      }
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
  operationalConfig?: GenerationModelOperationalConfig;
  catalogRevision?: string;
}): Promise<GenerationStartResult> {
  requireKieGenerationConfiguration();
  const {
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
    operationalConfig,
    catalogRevision,
  } = params;

  if (!referenceVideoUrl || !characterImageUrl) {
    throw new Error('Motion generation requires both a reference video and a character image.');
  }

  // Motion inputs are forwarded to the provider as-is, so gate their sources
  // the same way as the resolved reference URLs elsewhere in this module.
  assertAllowedGenerationMediaSource(characterImageUrl);
  assertAllowedGenerationMediaSource(referenceVideoUrl);

  const selectedModel = MOTION_MODELS[model];
  if (!selectedModel) {
    throw new Error(`Unsupported motion model: ${model}`);
  }
  const runtimeConfig = operationalConfig
    ?? await loadGenerationModelOperationalConfig(model, catalogRevision
      ? { catalogRevision, schemaVersion: 1 }
      : undefined);
  const providerModelId = resolveProviderModelId(runtimeConfig, 'default', selectedModel.apiModelId);

  const computedCost = getMotionCost(model, mode, duration);
  const cost = resolveQuotedGenerationCost(computedCost, quotedCostCredits);
  let generationId: string | null = null;
  let predictionId: string | null = null;
  try {
    const reservation = await startGenerationRecord(creditSupabase, {
      user_id: userId,
      model,
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
        ...(catalogRevision ? { catalogRevision } : {}),
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
      model: providerModelId,
      input: {
        prompt: prompt.trim() || 'The character follows the reference performance naturally.',
        input_urls: [characterImageUrl],
        video_urls: [referenceVideoUrl],
        character_orientation: characterOrientation,
        mode,
      },
    }, undefined, { generationId, modelId: model });
    await markGenerationProviderStarted(creditSupabase, generationId, predictionId);

    await persistGenerationInputMedia({
      supabase: creditSupabase,
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
    if (!predictionId && generationId) {
      await settleGenerationStartFailureQuietly({
        creditSupabase,
        error,
        generationId,
        userId,
        cost,
      });
    }
    throw error;
  }
}

export async function startCatalogGeneration(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  userId: string;
  clientRequestKeyHash?: string | null;
  operation: GenericGenerationAdapterOperation;
  catalogRevision: string;
  prompt: string;
  settings: Record<string, CatalogPrimitive>;
  inputs?: CatalogGenerationInputAsset[];
  shots?: CatalogGenerationShot[];
  quotedCostCredits: number;
  sourceGenerationId?: string | null;
  persistInputMedia?: boolean;
  privateRecipe?: boolean;
  templateContext?: TemplateGenerationContext;
  /**
   * Callers that already ran the assets through resolveGenerationMediaSource
   * (the legacy start services do, as part of their validation) set this to
   * avoid a second resolve — re-signing an already-signed URL is wasted work.
   */
  inputsPreResolved?: boolean;
}): Promise<GenerationStartResult> {
  requireKieGenerationConfiguration();
  const {
    supabase,
    creditSupabase,
    userId,
    clientRequestKeyHash = null,
    operation,
    catalogRevision,
    prompt,
    settings,
    inputs = [],
    shots = [],
    quotedCostCredits,
    sourceGenerationId = null,
    persistInputMedia = true,
    privateRecipe = false,
    templateContext,
    inputsPreResolved = false,
  } = params;

  if (templateContext && !privateRecipe) {
    throw new GenerationServiceError('Template generations must keep their recipe private.', 500);
  }
  if (!Number.isInteger(quotedCostCredits) || quotedCostCredits < 0) {
    throw new GenerationServiceError('Invalid quoted generation cost.', 500);
  }

  const durationSetting = settings.duration;
  const duration = typeof durationSetting === 'number' && Number.isFinite(durationSetting)
    ? durationSetting
    : shots.reduce((total, shot) => (
        total + (typeof shot.duration === 'number' && Number.isFinite(shot.duration)
          ? shot.duration
          : 0)
      ), 0) || null;

  let generationId: string | null = null;
  let predictionId: string | null = null;
  try {
    const reservation = await startGenerationRecord(creditSupabase, {
      user_id: userId,
      model: operation.modelId,
      duration,
      cost: quotedCostCredits,
      client_request_key_hash: clientRequestKeyHash,
      prompt: privateRecipe ? null : (typeof prompt === 'string' ? prompt.trim() : ''),
      category: operation.kind === 'image' ? 'image' : 'video',
      creation_mode: operation.kind === 'motion' ? 'motion' : null,
      source_generation_id: sourceGenerationId,
      // Legacy readers (remix-source-server, generation detail views) consume
      // top-level setting keys, `elements`, and `compiledPrompt` from
      // workflow_settings. Keep those alongside the catalog-native
      // settings/inputs shape so migrating a model between payload paths never
      // changes what downstream features can read.
      workflow_settings: privateRecipe ? {} : {
        ...settings,
        model: operation.modelId,
        catalogRevision,
        compiledPrompt: typeof prompt === 'string' ? prompt.trim() : '',
        settings,
        ...(() => {
          const elements = inputs
            .filter((asset) => asset.handle)
            .map((asset) => ({
              ...(asset.elementId ? { id: asset.elementId } : {}),
              displayName: asset.label ?? asset.handle ?? '',
              handle: asset.handle!,
              storagePath: asset.storagePath ?? null,
              sourceGenerationId: asset.sourceGenerationId ?? null,
            }));
          return elements.length > 0 ? { elements } : {};
        })(),
        ...(shots.length > 0 ? { shots } : {}),
        inputs: inputs.map((asset) => ({
          slot: asset.slot,
          kind: asset.kind,
          ...(asset.assetId ? { assetId: asset.assetId } : {}),
          ...(typeof asset.durationSeconds === 'number'
            ? { durationSeconds: asset.durationSeconds }
            : {}),
          ...(asset.label ? { label: asset.label } : {}),
          ...(asset.handle ? { handle: asset.handle } : {}),
          ...(asset.storagePath ? { storagePath: asset.storagePath } : {}),
          ...(asset.sourceGenerationId
            ? { sourceGenerationId: asset.sourceGenerationId }
            : {}),
        })),
      },
    }, templateContext);
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

    // Resolved after the replay check on purpose: signing every input URL is a storage
    // round-trip per asset, and on a client retry the reservation returns the original
    // prediction and all of that work would be thrown away. Adapter errors raised here
    // settle through the quiet-settle catch below, which is an already-handled path.
    const resolvedInputs = inputsPreResolved
      ? inputs.map((asset) => ({ ...asset, url: asset.url ?? null }))
      : await Promise.all(inputs.map(async (asset) => ({
          ...asset,
          url: typeof asset.url === 'string' && asset.url.trim()
            ? await resolveGenerationMediaSource(
                supabase,
                asset.url,
                userId,
                { templateAssetScope: templateAssetScope(templateContext) },
              )
            : null,
        })));
    const providerRequest = buildGenerationProviderRequest({
      operation,
      prompt: typeof prompt === 'string' ? prompt.trim() : '',
      settings,
      inputs: resolvedInputs,
      shots,
    });

    predictionId = await createKieTask(
      providerRequest.body,
      providerRequest.endpoint,
      { generationId, modelId: operation.modelId },
    );
    await markGenerationProviderStarted(creditSupabase, generationId, predictionId);

    if (persistInputMedia) {
      // Reference images are numbered per media type so their labels read the same as
      // the legacy path's ("Reference image 1"), which downstream remix and creation
      // views display verbatim.
      let referenceImageOrdinal = 0;
      const candidates: PersistGenerationInputCandidate[] = resolvedInputs.flatMap((asset, index) => {
        if (!asset.url) return [];
        const mediaType = asset.kind === 'video'
          ? 'video'
          : asset.kind === 'audio'
            ? 'audio'
            : 'image';
        const role = mediaType === 'video'
          ? 'reference_video'
          : mediaType === 'audio'
            ? 'reference_audio'
            : asset.slot === 'startFrame'
              ? 'start_frame'
              : asset.slot === 'endFrame'
                ? 'end_frame'
                : asset.kind === 'character'
                  ? 'character_image'
                  : 'reference_image';
        if (role === 'reference_image') referenceImageOrdinal += 1;
        return [{
          mediaType,
          role,
          label: asset.label
            ?? (role === 'reference_image' ? `Reference image ${referenceImageOrdinal}` : asset.slot),
          sourceUrl: asset.url,
          sourceStoragePath: asset.storagePath ?? null,
          sourceGenerationId: asset.sourceGenerationId ?? null,
          sortOrder: index,
          // Element identity must survive: toRemixImageElement reads id/displayName/handle
          // back out of this metadata, and without them remix falls back to the row id
          // and loses the name the user gave the reference.
          metadata: {
            slot: asset.slot,
            ...(asset.elementId ? { id: asset.elementId } : {}),
            ...(asset.label ? { displayName: asset.label } : {}),
            ...(asset.handle ? { handle: asset.handle } : {}),
            ...(typeof asset.durationSeconds === 'number'
              ? { durationSeconds: asset.durationSeconds }
              : {}),
          },
        } satisfies PersistGenerationInputCandidate];
      });
      if (candidates.length > 0) {
        await persistGenerationInputMedia({
          supabase: creditSupabase,
          generationId,
          userId,
          candidates,
        });
      }
    }

    return {
      predictionId,
      remainingCredits: reservation.remainingCredits,
      cost: reservation.cost,
      generationId,
    };
  } catch (error) {
    if (!predictionId && generationId) {
      if (templateContext) {
        await settleTemplateGenerationStartFailureQuietly({
          creditSupabase,
          error,
          generationId,
          model: operation.modelId,
          templateContext,
          userId,
          cost: quotedCostCredits,
        });
      } else {
        await settleGenerationStartFailureQuietly({
          creditSupabase,
          error,
          generationId,
          userId,
          cost: quotedCostCredits,
        });
      }
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
  requireKieGenerationConfiguration();
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

    const reservation = await startGenerationRecord(creditSupabase, {
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
      input,
    }, undefined, { generationId, modelId: model });
    await markGenerationProviderStarted(creditSupabase, generationId, predictionId);

    return {
      predictionId,
      remainingCredits: reservation.remainingCredits,
      cost,
      generationId,
    };
  } catch (error) {
    if (!predictionId && generationId) {
      await settleGenerationStartFailureQuietly({
        creditSupabase,
        error,
        generationId,
        userId,
        cost,
      });
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
  requireKieGenerationConfiguration();
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
  let generationId: string | null = null;
  let predictionId: string | null = null;

  try {
    const reservation = await startGenerationRecord(creditSupabase, {
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
        text: trimmedPrompt,
        loop,
        duration_seconds: duration,
        prompt_influence: promptInfluence,
        output_format: outputFormat,
      },
    }, undefined, { generationId, modelId: model });
    await markGenerationProviderStarted(creditSupabase, generationId, predictionId);

    return {
      predictionId,
      remainingCredits: reservation.remainingCredits,
      cost,
      generationId,
    };
  } catch (error) {
    if (!predictionId && generationId) {
      await settleGenerationStartFailureQuietly({
        creditSupabase,
        error,
        generationId,
        userId,
        cost,
      });
    }
    throw error;
  }
}
