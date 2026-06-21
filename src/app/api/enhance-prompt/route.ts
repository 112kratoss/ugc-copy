import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
    BackendRateLimitError,
    createBackendRateLimitResponse,
    enforceBackendRateLimit,
    PROMPT_ENHANCEMENT_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import {
    getPromptEnhancementCost,
    buildEnhancerSystemPrompt,
    buildPromptEnhancementArtifacts,
    applyPromptEnhancementSafeguardsWithMetadata,
    callPromptEnhancer,
    PROMPT_ENHANCER_PROVIDER_MODEL,
    SUPPORTED_ENHANCEMENT_MODELS,
    Medium,
    EnhancerContext,
} from '@/lib/prompt-enhancer';
import { inspectPromptQuality } from '@/lib/prompt-quality';
import {
    AiUsageLedgerError,
    markAiUsageSucceeded,
    refundAiUsageLedger,
    startAiUsageLedger,
} from '@/lib/ai-usage-ledger';

export async function POST(request: NextRequest) {
    try {
        // 1. Authenticate with the shared user-scoped Supabase helper.
        const supabase = createUserClient(request);

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
        await enforceBackendRateLimit(adminSupabase, {
            ...PROMPT_ENHANCEMENT_RATE_LIMIT,
            key: user.id,
        });

        let ledger;
        try {
            ledger = await startAiUsageLedger(adminSupabase, {
                userId: user.id,
                feature: 'prompt_enhancement',
                provider: 'kie',
                model: PROMPT_ENHANCER_PROVIDER_MODEL,
                medium,
                cost,
                inputPrompt: prompt,
            });
        } catch (ledgerError) {
            if (ledgerError instanceof AiUsageLedgerError) {
                if (ledgerError.code === 'INSUFFICIENT_CREDITS') {
                    return NextResponse.json(
                        { error: 'Insufficient credits', required: cost },
                        { status: 402 }
                    );
                }

                return NextResponse.json({ error: ledgerError.message }, { status: ledgerError.status });
            }

            throw ledgerError;
        }

        try {
            const systemPrompt = buildEnhancerSystemPrompt(
                medium as Medium,
                selectedModel,
                context,
                prompt
            );

            const result = await callPromptEnhancer(systemPrompt, prompt);
            const artifacts = buildPromptEnhancementArtifacts(
                medium as Medium,
                selectedModel,
                result.enhancedPrompt,
                context,
                prompt
            );
            const safeguardResult = applyPromptEnhancementSafeguardsWithMetadata(
                prompt,
                artifacts.compiledPrompt,
                context
            );
            const enhancedPrompt = safeguardResult.enhancedPrompt;
            const finalInspection = inspectPromptQuality({
                medium: medium as Medium,
                selectedModel,
                prompt: enhancedPrompt,
                context,
            });

            await markAiUsageSucceeded(adminSupabase, ledger, enhancedPrompt);

            return NextResponse.json({
                enhancedPrompt,
                remainingCredits: ledger.remainingCredits,
                agentId: artifacts.agentId,
                qualityScore: finalInspection.qualityScore,
                warnings: finalInspection.warnings,
                appliedSafeguards: [
                    ...artifacts.appliedSafeguards,
                    ...safeguardResult.appliedSafeguards,
                ],
            });
        } catch (enhanceError) {
            console.error('[EnhancePrompt] Enhancement failed:', enhanceError);

            await refundAiUsageLedger(adminSupabase, ledger, enhanceError);

            return NextResponse.json(
                {
                    error: 'Prompt enhancement failed. Your credits have been refunded.',
                    remainingCredits: ledger.remainingCredits + cost,
                },
                { status: 502 }
            );
        }
    } catch (error) {
        if (error instanceof BackendRateLimitError) {
            return createBackendRateLimitResponse(error);
        }

        console.error('[EnhancePrompt] Unexpected error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
