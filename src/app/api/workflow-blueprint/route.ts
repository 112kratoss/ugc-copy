import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/server-helpers';
import {
  buildWorkflowSystemPrompt,
  buildWorkflowUserPrompt,
  extractBlueprintFromResponse,
  sanitizeBlueprint,
  WORKFLOW_BLUEPRINT_COST,
  WorkflowPlannerInput,
} from '@/lib/workflow-blueprint';

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: request.headers.get('Authorization')! } } }
    );

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
    const { data: remainingCredits, error: creditError } = await adminSupabase.rpc('deduct_credits', {
      p_user_id: user.id,
      p_cost: WORKFLOW_BLUEPRINT_COST,
    });

    if (creditError) {
      return NextResponse.json({ error: 'Failed to deduct credits' }, { status: 500 });
    }

    if (remainingCredits === -1) {
      return NextResponse.json({ error: `Insufficient credits. Workflow generation costs ${WORKFLOW_BLUEPRINT_COST} credits.` }, { status: 402 });
    }

    const { data: usageEvent } = await adminSupabase
      .from('ai_usage_events')
      .insert({
        user_id: user.id,
        feature: 'workflow_blueprint',
        provider: 'kie',
        model: 'gemini-3-flash',
        medium: 'video',
        cost: WORKFLOW_BLUEPRINT_COST,
        status: 'pending',
        input_prompt: JSON.stringify(input).slice(0, 5000),
      })
      .select('id')
      .single();

    const eventId = usageEvent?.id;

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

      if (eventId) {
        await adminSupabase.from('ai_usage_events').update({
          status: 'succeeded',
          output_text: JSON.stringify(blueprint).slice(0, 5000),
        }).eq('id', eventId);
      }

      return NextResponse.json({ blueprint, remainingCredits });
    } catch (error) {
      if (eventId) {
        await adminSupabase.rpc('refund_ai_usage_event', { p_event_id: eventId });
        await adminSupabase.from('ai_usage_events').update({
          error_message: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown error',
        }).eq('id', eventId);
      } else {
        await adminSupabase.rpc('refund_credits', { p_user_id: user.id, p_amount: WORKFLOW_BLUEPRINT_COST });
      }

      return NextResponse.json({ error: 'Workflow planning failed. Credits refunded.' }, { status: 502 });
    }
  } catch (error) {
    console.error('[WorkflowBlueprint]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
