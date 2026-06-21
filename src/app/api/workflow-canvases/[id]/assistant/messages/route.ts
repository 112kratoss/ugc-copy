import { NextRequest, NextResponse } from 'next/server';

import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
  WORKFLOW_ASSISTANT_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import { createServiceClient } from '@/lib/server-helpers';
import {
  buildWorkflowAssistantSystemPrompt,
  buildWorkflowAssistantUserPrompt,
  createWorkflowAssistantGraphProposal,
  extractWorkflowAssistantBlueprintFromResponse,
  summarizeWorkflowAssistantRegion,
  summarizeWorkflowCanvasForAssistant,
  WORKFLOW_ASSISTANT_COST,
} from '@/lib/workflow-assistant';
import { authenticateRequest } from '@/lib/server-helpers';
import {
  AiUsageLedgerError,
  markAiUsageSucceeded,
  refundAiUsageLedger,
  startAiUsageLedger,
} from '@/lib/ai-usage-ledger';
import {
  isMissingWorkflowCanvasAssistantSchemaError,
} from '../../../workflowCanvasRouteCompat';
import {
  createWorkflowAssistantSetupRequiredResponse,
  loadOwnedWorkflowCanvas,
  normalizeAssistantMessages,
  normalizeAssistantProposalRecord,
} from '../assistantRouteShared';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const { supabase, userId } = auth;
  const body = await request.json().catch(() => ({}));
  const content = typeof body.content === 'string' ? body.content.trim() : '';

  if (!content) {
    return NextResponse.json({ error: 'Message content is required.' }, { status: 400 });
  }

  const canvas = await loadOwnedWorkflowCanvas(supabase, id, userId);
  if (!canvas) {
    return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
  }

  let recentMessages = [] as ReturnType<typeof normalizeAssistantMessages>;
  try {
    const messageHistoryResult = await supabase
      .from('workflow_canvas_assistant_messages')
      .select('id, canvas_id, role, content, proposal_id, created_at')
      .eq('canvas_id', id)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (messageHistoryResult.error) {
      if (isMissingWorkflowCanvasAssistantSchemaError(messageHistoryResult.error)) {
        return createWorkflowAssistantSetupRequiredResponse();
      }

      throw messageHistoryResult.error;
    }

    const assistantProposalPreflight = await supabase
      .from('workflow_canvas_assistant_proposals')
      .select('id')
      .eq('canvas_id', id)
      .eq('user_id', userId)
      .limit(1);

    if (assistantProposalPreflight.error) {
      if (isMissingWorkflowCanvasAssistantSchemaError(assistantProposalPreflight.error)) {
        return createWorkflowAssistantSetupRequiredResponse();
      }

      throw assistantProposalPreflight.error;
    }

    recentMessages = normalizeAssistantMessages(messageHistoryResult.data ?? []).slice(-6);
  } catch (error) {
    console.error('Failed to preflight workflow assistant persistence:', error);
    return NextResponse.json({ error: 'Failed to load workflow assistant state.' }, { status: 500 });
  }

  const adminSupabase = createServiceClient();

  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...WORKFLOW_ASSISTANT_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    console.error('Workflow assistant rate limit failed:', error);
    return NextResponse.json({ error: 'Failed to check workflow assistant limits.' }, { status: 500 });
  }

  let ledger;
  try {
    ledger = await startAiUsageLedger(adminSupabase, {
      userId,
      feature: 'workflow_assistant',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'video',
      cost: WORKFLOW_ASSISTANT_COST,
      inputPrompt: content,
    });
  } catch (ledgerError) {
    if (ledgerError instanceof AiUsageLedgerError) {
      if (ledgerError.code === 'INSUFFICIENT_CREDITS') {
        return NextResponse.json({ error: `Insufficient credits. Workflow generation costs ${WORKFLOW_ASSISTANT_COST} credits.` }, { status: 402 });
      }

      return NextResponse.json({ error: ledgerError.message }, { status: ledgerError.status });
    }

    throw ledgerError;
  }

  try {
    const response = await fetch('https://api.kie.ai/gemini-3-flash/v1/chat/completions', {
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
                currentCanvasSummary: summarizeWorkflowCanvasForAssistant(canvas.graph),
                assistantRegionSummary: summarizeWorkflowAssistantRegion(canvas.graph),
                recentMessages,
                latestUserMessage: content,
              }),
            }],
          },
          {
            role: 'user',
            content: [{
              type: 'text',
              text: buildWorkflowAssistantUserPrompt({
                currentCanvasSummary: summarizeWorkflowCanvasForAssistant(canvas.graph),
                assistantRegionSummary: summarizeWorkflowAssistantRegion(canvas.graph),
                recentMessages,
                latestUserMessage: content,
              }),
            }],
          },
        ],
        stream: false,
        include_thoughts: false,
        reasoning_effort: 'low',
      }),
    });

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
      .eq('canvas_id', id)
      .eq('user_id', userId)
      .eq('status', 'ready');

    const proposalInsert = await supabase
      .from('workflow_canvas_assistant_proposals')
      .insert({
        canvas_id: id,
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
          canvas_id: id,
          user_id: userId,
          role: 'user',
          content,
          proposal_id: proposal.id,
        },
        {
          canvas_id: id,
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

    await markAiUsageSucceeded(adminSupabase, ledger, JSON.stringify({
      proposalId: proposal.id,
      summary: blueprint.changeSummary,
      reply: blueprint.assistantReply,
    }));

    return NextResponse.json({
      messages: normalizeAssistantMessages(messageInsert.data ?? []),
      proposal,
      remainingCredits: ledger.remainingCredits,
    });
  } catch (error) {
    if (isMissingWorkflowCanvasAssistantSchemaError(error)) {
      await refundAiUsageLedger(adminSupabase, ledger, error);
      console.error('Workflow assistant persistence is unavailable:', error);
      return createWorkflowAssistantSetupRequiredResponse();
    }

    await refundAiUsageLedger(adminSupabase, ledger, error);

    console.error('Workflow assistant generation failed:', error);
    return NextResponse.json({ error: 'Workflow assistant failed. Credits refunded.' }, { status: 502 });
  }
}
