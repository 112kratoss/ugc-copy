import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
  WORKFLOW_BLUEPRINT_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import {
  buildWorkflowSystemPrompt,
  buildWorkflowUserPrompt,
  extractBlueprintFromResponse,
  sanitizeBlueprint,
  WORKFLOW_BLUEPRINT_COST,
  WorkflowPlannerInput,
} from '@/lib/workflow-blueprint';
import {
  AiUsageLedgerError,
  markAiUsageSucceeded,
  refundAiUsageLedger,
  startAiUsageLedger,
} from '@/lib/ai-usage-ledger';

export async function POST(request: NextRequest) {
  try {
    const supabase = createUserClient(request);

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const input = await request.json() as WorkflowPlannerInput;
    if (!input.productName?.trim() || !input.audience?.trim() || !input.primaryMessage?.trim()) {
      return NextResponse.json({ error: 'Product name, audience, and primary message are required.' }, { status: 400 });
    }

    if (!process.env.KIE_AI_API_KEY) {
      return NextResponse.json({ error: 'Server configuration error: API key missing' }, { status: 500 });
    }

    const adminSupabase = createServiceClient();
    try {
      await enforceBackendRateLimit(adminSupabase, {
        ...WORKFLOW_BLUEPRINT_RATE_LIMIT,
        key: user.id,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      console.error('[WorkflowBlueprint] Rate limit failed:', error);
      return NextResponse.json({ error: 'Failed to check workflow planning limits.' }, { status: 500 });
    }

    let ledger;
    try {
      ledger = await startAiUsageLedger(adminSupabase, {
        userId: user.id,
        feature: 'workflow_blueprint',
        provider: 'kie',
        model: 'gemini-3-flash',
        medium: 'video',
        cost: WORKFLOW_BLUEPRINT_COST,
        inputPrompt: JSON.stringify(input),
      });
    } catch (ledgerError) {
      if (ledgerError instanceof AiUsageLedgerError) {
        if (ledgerError.code === 'INSUFFICIENT_CREDITS') {
          return NextResponse.json({ error: `Insufficient credits. Workflow generation costs ${WORKFLOW_BLUEPRINT_COST} credits.` }, { status: 402 });
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
            { role: 'system', content: [{ type: 'text', text: buildWorkflowSystemPrompt(input) }] },
            { role: 'user', content: [{ type: 'text', text: buildWorkflowUserPrompt(input) }] },
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
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('Invalid planner response');
      }

      const blueprint = sanitizeBlueprint(extractBlueprintFromResponse(content));

      await markAiUsageSucceeded(adminSupabase, ledger, JSON.stringify(blueprint));

      return NextResponse.json({ blueprint, remainingCredits: ledger.remainingCredits });
    } catch (error) {
      await refundAiUsageLedger(adminSupabase, ledger, error);

      return NextResponse.json({ error: 'Workflow planning failed. Credits refunded.' }, { status: 502 });
    }
  } catch (error) {
    console.error('[WorkflowBlueprint]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
