import type { SupabaseClient } from '@supabase/supabase-js';

import {
  AiUsageLedgerError,
  buildAiUsageReplayResponse,
  getAiUsageLedgerIdempotencyKey,
  markAiUsageSucceeded,
  refundAiUsageLedger,
  startAiUsageLedger,
} from '@/lib/ai-usage-ledger';
import {
  BackendRateLimitError,
  WORKFLOW_BLUEPRINT_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS,
  fetchWithProviderTimeout,
} from '@/lib/provider-fetch';
import {
  WORKFLOW_BLUEPRINT_COST,
  buildWorkflowSystemPrompt,
  buildWorkflowUserPrompt,
  extractBlueprintFromResponse,
  sanitizeBlueprint,
  type WorkflowPlannerInput,
} from '@/lib/workflow-blueprint';

type RouteBody = Record<string, unknown>;

type WorkflowBlueprintRouteClient = SupabaseClient;

type ProviderFetch = typeof fetchWithProviderTimeout;

export type WorkflowBlueprintRouteResult =
  | {
    ok: true;
    body: RouteBody;
  }
  | {
    ok: false;
    body: RouteBody;
    status: number;
    rateLimitError?: BackendRateLimitError;
  };

export interface WorkflowBlueprintRouteInput {
  createAdminSupabase: () => unknown;
  createUserSupabase: () => unknown;
  kieApiKey?: string;
  providerFetch?: ProviderFetch;
  readRequestBody?: () => Promise<unknown>;
  request: Request;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateWorkflowPlannerInput(body: unknown): WorkflowPlannerInput | WorkflowBlueprintRouteResult {
  if (!isRecord(body)) {
    return {
      ok: false,
      body: { error: 'Product name, audience, and primary message are required.' },
      status: 400,
    };
  }

  const input = body as unknown as WorkflowPlannerInput;
  if (!input.productName?.trim() || !input.audience?.trim() || !input.primaryMessage?.trim()) {
    return {
      ok: false,
      body: { error: 'Product name, audience, and primary message are required.' },
      status: 400,
    };
  }

  return input;
}

async function getAuthenticatedUserId(supabase: WorkflowBlueprintRouteClient) {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  return authError || !user ? null : user.id;
}

async function readRequestBody(input: WorkflowBlueprintRouteInput) {
  return input.readRequestBody ? input.readRequestBody() : input.request.json();
}

function mapLedgerError(error: AiUsageLedgerError): WorkflowBlueprintRouteResult {
  if (error.code === 'INSUFFICIENT_CREDITS') {
    return {
      ok: false,
      body: { error: `Insufficient credits. Workflow generation costs ${WORKFLOW_BLUEPRINT_COST} credits.` },
      status: 402,
    };
  }

  return {
    ok: false,
    body: { error: error.message },
    status: error.status,
  };
}

async function buildProviderBlueprint(
  input: WorkflowPlannerInput,
  kieApiKey: string,
  providerFetch: ProviderFetch,
) {
  const response = await providerFetch('https://api.kie.ai/gemini-3-flash/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${kieApiKey}`,
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: [{ type: 'text', text: buildWorkflowSystemPrompt(input) }] },
        { role: 'user', content: [{ type: 'text', text: buildWorkflowUserPrompt(input) }] },
      ],
      stream: false,
      include_thoughts: false,
      reasoning_effort: 'low',
    }),
  }, PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS, fetch, 'KIE workflow blueprint');

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Invalid planner response');
  }

  return sanitizeBlueprint(extractBlueprintFromResponse(content));
}

export async function planWorkflowBlueprintForRoute(
  input: WorkflowBlueprintRouteInput,
): Promise<WorkflowBlueprintRouteResult> {
  try {
    const supabase = input.createUserSupabase() as WorkflowBlueprintRouteClient;
    const userId = await getAuthenticatedUserId(supabase);
    if (!userId) {
      return { ok: false, body: { error: 'Unauthorized' }, status: 401 };
    }

    const body = await readRequestBody(input);
    const validated = validateWorkflowPlannerInput(body);
    if ('ok' in validated) {
      return validated;
    }

    if (!input.kieApiKey) {
      return {
        ok: false,
        body: { error: 'Server configuration error: API key missing' },
        status: 500,
      };
    }

    const adminSupabase = input.createAdminSupabase() as WorkflowBlueprintRouteClient;
    try {
      await enforceBackendRateLimit(adminSupabase, {
        ...WORKFLOW_BLUEPRINT_RATE_LIMIT,
        key: userId,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return {
          ok: false,
          body: { error: error.message },
          status: error.status,
          rateLimitError: error,
        };
      }

      console.error('[WorkflowBlueprint] Rate limit failed:', error);
      return {
        ok: false,
        body: { error: 'Failed to check workflow planning limits.' },
        status: 500,
      };
    }

    let ledger;
    try {
      const idempotencyKey = getAiUsageLedgerIdempotencyKey(input.request, body as Record<string, unknown>);
      ledger = await startAiUsageLedger(adminSupabase, {
        userId,
        feature: 'workflow_blueprint',
        provider: 'kie',
        model: 'gemini-3-flash',
        medium: 'video',
        cost: WORKFLOW_BLUEPRINT_COST,
        inputPrompt: JSON.stringify(validated),
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof AiUsageLedgerError) {
        return mapLedgerError(error);
      }

      throw error;
    }

    if (ledger.idempotentReplay) {
      return { ok: true, body: buildAiUsageReplayResponse(ledger) };
    }

    try {
      const blueprint = await buildProviderBlueprint(
        validated,
        input.kieApiKey,
        input.providerFetch ?? fetchWithProviderTimeout,
      );
      const responsePayload = { blueprint, remainingCredits: ledger.remainingCredits };

      await markAiUsageSucceeded(adminSupabase, ledger, JSON.stringify(blueprint), responsePayload);

      return { ok: true, body: responsePayload };
    } catch (error) {
      await refundAiUsageLedger(adminSupabase, ledger, error);

      return {
        ok: false,
        body: { error: 'Workflow planning failed. Credits refunded.' },
        status: 502,
      };
    }
  } catch (error) {
    console.error('[WorkflowBlueprint]', error);
    return {
      ok: false,
      body: { error: 'Internal server error' },
      status: 500,
    };
  }
}
