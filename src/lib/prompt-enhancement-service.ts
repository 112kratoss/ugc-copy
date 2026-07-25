import {
  BackendRateLimitError,
  PROMPT_ENHANCEMENT_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  AiUsageLedgerError,
  buildAiUsageReplayResponse,
  getAiUsageLedgerIdempotencyKey,
  markAiUsageSucceeded,
  refundAiUsageLedger,
  startAiUsageLedger,
} from '@/lib/ai-usage-ledger';
import {
  PROMPT_ENHANCER_PROVIDER_MODEL,
  SUPPORTED_ENHANCEMENT_MODELS,
  applyPromptEnhancementSafeguardsWithMetadata,
  buildEnhancerSystemPrompt,
  buildPromptEnhancementArtifacts,
  callPromptEnhancer,
  getPromptEnhancementCost,
  type EnhancerContext,
  type Medium,
} from '@/lib/prompt-enhancer';
import { inspectPromptQuality } from '@/lib/prompt-quality';
import { logBackendError } from '@/lib/backend-logger';

export type PromptEnhancementClient =
  Parameters<typeof enforceBackendRateLimit>[0]
  & Parameters<typeof startAiUsageLedger>[0];

export type PromptEnhancementResult =
  | {
    ok: true;
    response: Record<string, unknown>;
  }
  | {
    ok: false;
    status: number;
    error: string;
    code?: string;
    required?: number;
    remainingCredits?: number;
    retryAfterSeconds?: number;
    limit?: number;
    remaining?: number;
    resetAt?: string;
  };

type EnhancePromptForUserInput = {
  body: unknown;
  userId: string;
  request: Request;
  client: PromptEnhancementClient | (() => PromptEnhancementClient);
};

type PromptEnhancementRequest = {
  medium: Medium;
  selectedModel: string;
  prompt: string;
  context?: EnhancerContext;
  bodyRecord: Record<string, unknown>;
};

const VALID_MEDIUMS: Medium[] = ['image', 'video', 'motion'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validatePromptEnhancementBody(body: unknown): PromptEnhancementRequest | { error: string; status: number } {
  if (!isRecord(body)) {
    return { error: 'Prompt is required', status: 400 };
  }

  const medium = body.medium;
  const selectedModel = body.selectedModel;
  const prompt = body.prompt;
  const context = body.context;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { error: 'Prompt is required', status: 400 };
  }

  if (!medium || !VALID_MEDIUMS.includes(medium as Medium)) {
    return {
      error: `Invalid medium. Must be one of: ${VALID_MEDIUMS.join(', ')}`,
      status: 400,
    };
  }

  if (!selectedModel || typeof selectedModel !== 'string' || !SUPPORTED_ENHANCEMENT_MODELS.has(selectedModel)) {
    return {
      error: `Unsupported model: ${selectedModel}`,
      status: 400,
    };
  }

  return {
    medium: medium as Medium,
    selectedModel,
    prompt,
    context: isRecord(context) ? context as EnhancerContext : context as EnhancerContext | undefined,
    bodyRecord: body,
  };
}

function resolveClient(client: EnhancePromptForUserInput['client']) {
  return typeof client === 'function' ? client() : client;
}

function mapRateLimitError(error: BackendRateLimitError): PromptEnhancementResult {
  return {
    ok: false,
    status: error.status,
    code: 'RATE_LIMITED',
    error: error.message,
    retryAfterSeconds: error.retryAfterSeconds,
    limit: error.state.limit,
    remaining: error.state.remaining,
    resetAt: error.state.resetAt,
  };
}

function mapLedgerError(error: AiUsageLedgerError, cost: number): PromptEnhancementResult {
  if (error.code === 'INSUFFICIENT_CREDITS') {
    return {
      ok: false,
      status: 402,
      error: 'Insufficient credits',
      required: cost,
    };
  }

  return {
    ok: false,
    status: error.status,
    error: error.message,
  };
}

export async function enhancePromptForUser({
  body,
  userId,
  request,
  client,
}: EnhancePromptForUserInput): Promise<PromptEnhancementResult> {
  const validated = validatePromptEnhancementBody(body);
  if ('error' in validated) {
    return {
      ok: false,
      status: validated.status,
      error: validated.error,
    };
  }

  const cost = getPromptEnhancementCost();
  const resolvedClient = resolveClient(client);

  try {
    await enforceBackendRateLimit(resolvedClient, {
      ...PROMPT_ENHANCEMENT_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return mapRateLimitError(error);
    }

    throw error;
  }

  let ledger;
  try {
    const idempotencyKey = getAiUsageLedgerIdempotencyKey(request, validated.bodyRecord);
    ledger = await startAiUsageLedger(resolvedClient, {
      userId,
      feature: 'prompt_enhancement',
      provider: 'kie',
      model: PROMPT_ENHANCER_PROVIDER_MODEL,
      medium: validated.medium,
      cost,
      inputPrompt: validated.prompt,
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof AiUsageLedgerError) {
      return mapLedgerError(error, cost);
    }

    throw error;
  }

  if (ledger.idempotentReplay) {
    return {
      ok: true,
      response: buildAiUsageReplayResponse(ledger),
    };
  }

  try {
    const systemPrompt = buildEnhancerSystemPrompt(
      validated.medium,
      validated.selectedModel,
      validated.context,
      validated.prompt
    );

    const result = await callPromptEnhancer(systemPrompt, validated.prompt);
    const artifacts = buildPromptEnhancementArtifacts(
      validated.medium,
      validated.selectedModel,
      result.enhancedPrompt,
      validated.context,
      validated.prompt
    );
    const safeguardResult = applyPromptEnhancementSafeguardsWithMetadata(
      validated.prompt,
      artifacts.compiledPrompt,
      validated.context
    );
    const enhancedPrompt = safeguardResult.enhancedPrompt;
    const finalInspection = inspectPromptQuality({
      medium: validated.medium,
      selectedModel: validated.selectedModel,
      prompt: enhancedPrompt,
      context: validated.context,
    });

    const responsePayload = {
      enhancedPrompt,
      remainingCredits: ledger.remainingCredits,
      agentId: artifacts.agentId,
      qualityScore: finalInspection.qualityScore,
      warnings: finalInspection.warnings,
      appliedSafeguards: [
        ...artifacts.appliedSafeguards,
        ...safeguardResult.appliedSafeguards,
      ],
    };

    await markAiUsageSucceeded(resolvedClient, ledger, enhancedPrompt, responsePayload);

    return {
      ok: true,
      response: responsePayload,
    };
  } catch (error) {
    logBackendError('enhanceprompt_enhancement_failed', { error: error });

    await refundAiUsageLedger(resolvedClient, ledger, error);

    return {
      ok: false,
      status: 502,
      error: 'Prompt enhancement failed. Your credits have been refunded.',
      remainingCredits: ledger.remainingCredits + cost,
    };
  }
}
