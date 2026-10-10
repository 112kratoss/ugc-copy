import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  enforceBackendRateLimit,
  WORKFLOW_ASSISTANT_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import {
  AiUsageLedgerError,
  buildAiUsageReplayResponse,
  getAiUsageLedgerIdempotencyKey,
  refundAiUsageLedger,
  startAiUsageLedger,
  type AiUsageLedger,
} from '@/lib/ai-usage-ledger';
import {
  buildWorkflowAssistantSystemPrompt,
  buildWorkflowAssistantUserPrompt,
  createWorkflowAssistantGraphProposal,
  extractWorkflowAssistantBlueprintFromResponse,
  summarizeWorkflowAssistantRegion,
  summarizeWorkflowCanvasForAssistant,
  WORKFLOW_ASSISTANT_COST,
} from '@/lib/workflow-assistant';
import {
  createWorkflowAssistantSetupRequiredBody,
  loadOwnedWorkflowCanvas,
  normalizeAssistantMessages,
} from '@/lib/workflow-assistant-route-shared';
import {
  fetchWithProviderTimeout,
  PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS,
} from '@/lib/provider-fetch';
import {
  isMissingWorkflowCanvasAssistantSchemaError,
} from '@/lib/workflow-canvas-route-compat';

const WORKFLOW_ASSISTANT_PROMPT_HISTORY_LIMIT = 6;

export type WorkflowAssistantMessageRouteResult =
  | {
      ok: true;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 400 | 402 | 404 | 409 | 429 | 500 | 502 | 503;
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    };

function createRateLimitResult(error: BackendRateLimitError): WorkflowAssistantMessageRouteResult {
  return {
    ok: false,
    status: 429,
    headers: {
      'Retry-After': String(error.retryAfterSeconds),
      'X-RateLimit-Limit': String(error.state.limit),
      'X-RateLimit-Remaining': String(error.state.remaining),
      'X-RateLimit-Reset': error.state.resetAt,
    },
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

async function loadRecentAssistantMessages({
  canvasId,
  supabase,
  userId,
}: {
  canvasId: string;
  supabase: SupabaseClient;
  userId: string;
}) {
  try {
    const messageHistoryResult = await supabase
      .from('workflow_canvas_assistant_messages')
      .select('id, canvas_id, role, content, proposal_id, created_at')
      .eq('canvas_id', canvasId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(WORKFLOW_ASSISTANT_PROMPT_HISTORY_LIMIT);

    if (messageHistoryResult.error) {
      if (isMissingWorkflowCanvasAssistantSchemaError(messageHistoryResult.error)) {
        return { kind: 'setup_required' as const };
      }

      throw messageHistoryResult.error;
    }

    const assistantProposalPreflight = await supabase
      .from('workflow_canvas_assistant_proposals')
      .select('id')
      .eq('canvas_id', canvasId)
      .eq('user_id', userId)
      .limit(1);

    if (assistantProposalPreflight.error) {
      if (isMissingWorkflowCanvasAssistantSchemaError(assistantProposalPreflight.error)) {
        return { kind: 'setup_required' as const };
      }

      throw assistantProposalPreflight.error;
    }

    return {
      kind: 'ready' as const,
      recentMessages: normalizeAssistantMessages([...(messageHistoryResult.data ?? [])].reverse()),
    };
  } catch (error) {
    logBackendError('failed_to_preflight_workflow_assistant_persistence', { error: error });
    return { kind: 'failed' as const };
  }
}

async function startWorkflowAssistantUsage({
  adminSupabase,
  content,
  idempotencyKey,
  userId,
}: {
  adminSupabase: SupabaseClient;
  content: string;
  idempotencyKey: string | null;
  userId: string;
}): Promise<
  | { ok: true; ledger: AiUsageLedger }
  | { ok: false; result: WorkflowAssistantMessageRouteResult }
> {
  try {
    return {
      ok: true,
      ledger: await startAiUsageLedger(adminSupabase, {
        userId,
        feature: 'workflow_assistant',
        provider: 'kie',
        model: 'gemini-3-flash',
        medium: 'video',
        cost: WORKFLOW_ASSISTANT_COST,
        inputPrompt: content,
        idempotencyKey,
      }),
    };
  } catch (ledgerError) {
    if (ledgerError instanceof AiUsageLedgerError) {
      if (ledgerError.code === 'INSUFFICIENT_CREDITS') {
        return {
          ok: false,
          result: {
            ok: false,
            status: 402,
            body: {
              error: `Insufficient credits. Workflow generation costs ${WORKFLOW_ASSISTANT_COST} credits.`,
            },
          },
        };
      }

      return {
        ok: false,
        result: {
          ok: false,
          status: ledgerError.status as WorkflowAssistantMessageRouteResult extends { status: infer T } ? T & number : never,
          body: { error: ledgerError.message },
        },
      };
    }

    throw ledgerError;
  }
}

export async function createWorkflowAssistantMessageForRoute({
  adminSupabase,
  body,
  canvasId,
  idempotencyKey,
  request,
  supabase,
  userId,
}: {
  adminSupabase: SupabaseClient;
  body: unknown;
  canvasId: string;
  idempotencyKey?: string | null;
  request?: Request;
  supabase: SupabaseClient;
  userId: string;
}): Promise<WorkflowAssistantMessageRouteResult> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, body: { error: 'Message must be a JSON object.' } };
  }
  const message = body as Record<string, unknown>;
  const content = typeof message.content === 'string' ? message.content.trim() : '';

  if (!content) {
    return { ok: false, status: 400, body: { error: 'Message content is required.' } };
  }

  const canvas = await loadOwnedWorkflowCanvas(supabase, canvasId, userId);
  if (!canvas) {
    return { ok: false, status: 404, body: { error: 'Workflow canvas not found.' } };
  }

  const recentMessagesResult = await loadRecentAssistantMessages({ canvasId, supabase, userId });
  if (recentMessagesResult.kind === 'setup_required') {
    return { ok: false, status: 503, body: createWorkflowAssistantSetupRequiredBody() };
  }

  if (recentMessagesResult.kind === 'failed') {
    return { ok: false, status: 500, body: { error: 'Failed to load workflow assistant state.' } };
  }

  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...WORKFLOW_ASSISTANT_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('workflow_assistant_rate_limit_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to check workflow assistant limits.' } };
  }

  let ledgerIdempotencyKey = idempotencyKey ?? null;
  if (request) {
    try {
      ledgerIdempotencyKey = getAiUsageLedgerIdempotencyKey(request, message);
    } catch (error) {
      if (error instanceof AiUsageLedgerError) {
        return {
          ok: false,
          status: error.status as WorkflowAssistantMessageRouteResult extends { status: infer T } ? T & number : never,
          body: { error: error.message },
        };
      }

      throw error;
    }
  }

  const ledgerStart = await startWorkflowAssistantUsage({
    adminSupabase,
    content,
    idempotencyKey: ledgerIdempotencyKey,
    userId,
  });

  if (!ledgerStart.ok) {
    return ledgerStart.result;
  }

  const { ledger } = ledgerStart;
  if (ledger.idempotentReplay) {
    return { ok: true, body: buildAiUsageReplayResponse(ledger) };
  }

  try {
    const currentCanvasSummary = summarizeWorkflowCanvasForAssistant(canvas.graph);
    const assistantRegionSummary = summarizeWorkflowAssistantRegion(canvas.graph);
    const response = await fetchWithProviderTimeout('https://api.kie.ai/gemini-3-flash/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.KIE_AI_API_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: [{
              type: 'text',
              text: buildWorkflowAssistantSystemPrompt({
                currentCanvasSummary,
                assistantRegionSummary,
                recentMessages: recentMessagesResult.recentMessages,
                latestUserMessage: content,
              }),
            }],
          },
          {
            role: 'user',
            content: [{
              type: 'text',
              text: buildWorkflowAssistantUserPrompt({
                currentCanvasSummary,
                assistantRegionSummary,
                recentMessages: recentMessagesResult.recentMessages,
                latestUserMessage: content,
              }),
            }],
          },
        ],
        stream: false,
        include_thoughts: false,
        reasoning_effort: 'low',
      }),
    }, PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS, fetch, 'KIE workflow assistant');

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json();
    const rawAssistantContent = data?.choices?.[0]?.message?.content;

    if (typeof rawAssistantContent !== 'string') {
      throw new Error('Invalid assistant response');
    }

    const blueprint = extractWorkflowAssistantBlueprintFromResponse(rawAssistantContent, {
      latestUserMessage: content,
    });
    const proposalArtifacts = createWorkflowAssistantGraphProposal({
      currentGraph: canvas.graph,
      blueprint,
    });

    const completion = await adminSupabase.rpc('complete_workflow_assistant_message', {
      p_event_id: ledger.eventId,
      p_canvas_id: canvasId,
      p_user_id: userId,
      p_base_revision: canvas.revision,
      p_content: content,
      p_reply: blueprint.assistantReply,
      p_summary: blueprint.changeSummary,
      p_diff: proposalArtifacts.diff,
      p_proposed_graph: proposalArtifacts.proposedGraph,
    });
    if (completion.error) throw completion.error;
    if (!completion.data || typeof completion.data !== 'object' || Array.isArray(completion.data)
      || !Array.isArray(completion.data.messages) || !completion.data.proposal) {
      throw new Error('Invalid persisted assistant response.');
    }
    return { ok: true, body: completion.data as Record<string, unknown> };
  } catch (error) {
    // The transaction may have committed before its HTTP reply was lost. Only
    // a confirmed pending event may be refunded; a saved success is replayed.
    const saved = await adminSupabase.from('ai_usage_events')
      .select('status,refunded,response_payload').eq('id', ledger.eventId).eq('user_id', userId).maybeSingle();
    if (saved.error || !saved.data) {
      logBackendError('workflow_assistant_completion_state_unavailable', { error: saved.error });
      return { ok: false, status: 500, body: { error: 'Could not confirm the assistant result. Retry with the same request key.' } };
    }
    if (saved.data.status === 'succeeded' && saved.data.refunded === false
      && saved.data.response_payload && typeof saved.data.response_payload === 'object'
      && !Array.isArray(saved.data.response_payload)) {
      return { ok: true, body: saved.data.response_payload as Record<string, unknown> };
    }
    if (isMissingWorkflowCanvasAssistantSchemaError(error)) {
      await refundAiUsageLedger(adminSupabase, ledger, error);
      logBackendError('workflow_assistant_persistence_is_unavailable', { error: error });
      return { ok: false, status: 503, body: createWorkflowAssistantSetupRequiredBody() };
    }

    await refundAiUsageLedger(adminSupabase, ledger, error);

    logBackendError('workflow_assistant_generation_failed', { error: error });
    return { ok: false, status: 502, body: { error: 'Workflow assistant failed. Credits refunded.' } };
  }
}
