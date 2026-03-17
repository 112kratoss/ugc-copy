import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/server-helpers';
import {
    getPromptEnhancementCost,
    buildEnhancerSystemPrompt,
    callPromptEnhancer,
    SUPPORTED_ENHANCEMENT_MODELS,
    Medium,
    EnhancerContext,
} from '@/lib/prompt-enhancer';

export async function POST(request: NextRequest) {
    try {
        // 1. Authenticate (same pattern as other API routes)
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: { headers: { Authorization: request.headers.get('Authorization')! } },
            }
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // 2. Parse and validate body
        const body = await request.json();
        const { medium, selectedModel, prompt, context } = body as {
            medium: string;
            selectedModel: string;
            prompt: string;
            context?: EnhancerContext;
        };

        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
        }

        const validMediums: Medium[] = ['image', 'video', 'motion'];
        if (!medium || !validMediums.includes(medium as Medium)) {
            return NextResponse.json(
                { error: `Invalid medium. Must be one of: ${validMediums.join(', ')}` },
                { status: 400 }
            );
        }

        if (!selectedModel || !SUPPORTED_ENHANCEMENT_MODELS.has(selectedModel)) {
            return NextResponse.json(
                { error: `Unsupported model: ${selectedModel}` },
                { status: 400 }
            );
        }

        const cost = getPromptEnhancementCost();
        const adminSupabase = createServiceClient();

        // 3. Deduct credits
        const { data: remainingCredits, error: deductError } = await adminSupabase.rpc(
            'deduct_credits',
            { p_user_id: user.id, p_cost: cost }
        );

        if (deductError) {
            console.error('[EnhancePrompt] Credit deduction error:', deductError);
            return NextResponse.json({ error: 'Failed to deduct credits' }, { status: 500 });
        }

        if (remainingCredits === -1) {
            return NextResponse.json(
                { error: 'Insufficient credits', required: cost },
                { status: 402 }
            );
        }

        // 4. Insert usage event (pending)
        const { data: usageEvent, error: insertError } = await adminSupabase
            .from('ai_usage_events')
            .insert({
                user_id: user.id,
                feature: 'prompt_enhancement',
                provider: 'kie',
                model: 'gemini-3-flash',
                medium,
                cost,
                status: 'pending',
                input_prompt: prompt.substring(0, 5000),
            })
            .select('id')
            .single();

        if (insertError) {
            console.error('[EnhancePrompt] Usage event insert error:', insertError);
            // Non-fatal — continue with the enhancement
        }

        const eventId = usageEvent?.id;

        // 5. Build system prompt and call enhancer
        try {
            const systemPrompt = buildEnhancerSystemPrompt(
                medium as Medium,
                selectedModel,
                context
            );

            const result = await callPromptEnhancer(systemPrompt, prompt);

            // 6. Update usage event to succeeded
            if (eventId) {
                await adminSupabase
                    .from('ai_usage_events')
                    .update({
                        status: 'succeeded',
                        output_text: result.enhancedPrompt.substring(0, 5000),
                    })
                    .eq('id', eventId);
            }

            return NextResponse.json({
                enhancedPrompt: result.enhancedPrompt,
                remainingCredits,
            });
        } catch (enhanceError) {
            console.error('[EnhancePrompt] Enhancement failed:', enhanceError);

            // 7. Refund credits on failure
            if (eventId) {
                await adminSupabase.rpc('refund_ai_usage_event', { p_event_id: eventId });
            } else {
                // If we couldn't create an event, refund directly
                await adminSupabase.rpc('refund_credits', {
                    p_user_id: user.id,
                    p_amount: cost,
                });
            }

            // Update usage event with error
            if (eventId) {
                await adminSupabase
                    .from('ai_usage_events')
                    .update({
                        error_message:
                            enhanceError instanceof Error
                                ? enhanceError.message.substring(0, 1000)
                                : 'Unknown error',
                    })
                    .eq('id', eventId);
            }

            return NextResponse.json(
                {
                    error: 'Prompt enhancement failed. Your credits have been refunded.',
                    remainingCredits: remainingCredits + cost, // refunded
                },
                { status: 502 }
            );
        }
    } catch (error) {
        console.error('[EnhancePrompt] Unexpected error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
