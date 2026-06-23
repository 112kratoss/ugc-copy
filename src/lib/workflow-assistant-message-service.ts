import 'server-only';

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
  markAiUsageSucceeded,
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
  normalizeAssistantProposalRecord,
} from '@/lib/workflow-assistant-route-shared';
import {
  fetchWithProviderTimeout,
  PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS,
} from '@/lib/provider-fetch';
import {
  isMissingWorkflowCanvasAssistantSchemaError,
} from '@/lib/workflow-canvas-route-compat';

type WorkflowAssistantMessageBody = {
  content?: unknown;
};

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
      .order('created_at', { ascending: true });

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
      recentMessages: normalizeAssistantMessages(messageHistoryResult.data ?? []).slice(-6),
    };
  } catch (error) {
    console.error('Failed to preflight workflow assistant persistence:', error);
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
  body: WorkflowAssistantMessageBody;
  canvasId: string;
  idempotencyKey?: string | null;
  request?: Request;
  supabase: SupabaseClient;
  userId: string;
}): Promise<WorkflowAssistantMessageRouteResult> {
  const content = typeof body.content === 'string' ? body.content.trim() : '';

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

    console.error('Workflow assistant rate limit failed:', error);
    return { ok: false, status: 500, body: { error: 'Failed to check workflow assistant limits.' } };
  }

  let ledgerIdempotencyKey = idempotencyKey ?? null;
  if (request) {
    try {
      ledgerIdempotencyKey = getAiUsageLedgerIdempotencyKey(request, body as Record<string, unknown>);
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

    await supabase
      .from('workflow_canvas_assistant_proposals')
      .update({
        status: 'discarded',
        discarded_at: new Date().toISOString(),
      })
      .eq('canvas_id', canvasId)
      .eq('user_id', userId)
      .eq('status', 'ready');

    const proposalInsert = await supabase
      .from('workflow_canvas_assistant_proposals')
      .insert({
        canvas_id: canvasId,
        user_id: userId,
        base_revision: canvas.revision,
        status: 'ready',
        summary: blueprint.changeSummary,
        diff: proposalArtifacts.diff,
        proposed_graph: proposalArtifacts.proposedGraph,
      })
      .select('id, canvas_id, base_revision, status, summary, diff, proposed_graph, created_at, applied_at, discarded_at')
      .single();

    if (proposalInsert.error || !proposalInsert.data) {
      throw proposalInsert.error || new Error('Failed to persist assistant proposal.');
    }

    const proposal = normalizeAssistantProposalRecord(proposalInsert.data);
    if (!proposal) {
      throw new Error('Failed to normalize assistant proposal.');
    }

    const messageInsert = await supabase
      .from('workflow_canvas_assistant_messages')
      .insert([
        {
          canvas_id: canvasId,
          user_id: userId,
          role: 'user',
          content,
          proposal_id: proposal.id,
        },
        {
          canvas_id: canvasId,
          user_id: userId,
          role: 'assistant',
          content: blueprint.assistantReply,
          proposal_id: proposal.id,
        },
      ])
      .select('id, canvas_id, role, content, proposal_id, created_at')
      .order('created_at', { ascending: true });

    if (messageInsert.error) {
      throw messageInsert.error;
    }

    const messages = normalizeAssistantMessages(messageInsert.data ?? []);
    const responsePayload = {
      messages,
      proposal,
      remainingCredits: ledger.remainingCredits,
    };

    await markAiUsageSucceeded(adminSupabase, ledger, JSON.stringify({
      proposalId: proposal.id,
      summary: blueprint.changeSummary,
      reply: blueprint.assistantReply,
    }), responsePayload);

    return { ok: true, body: responsePayload };
  } catch (error) {
    if (isMissingWorkflowCanvasAssistantSchemaError(error)) {
      await refundAiUsageLedger(adminSupabase, ledger, error);
      console.error('Workflow assistant persistence is unavailable:', error);
      return { ok: false, status: 503, body: createWorkflowAssistantSetupRequiredBody() };
    }

    await refundAiUsageLedger(adminSupabase, ledger, error);

    console.error('Workflow assistant generation failed:', error);
    return { ok: false, status: 502, body: { error: 'Workflow assistant failed. Credits refunded.' } };
  }
}
