import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import {
    GenerationServiceError,
    getGenerationResultUrls,
    persistGeneratedOutputList,
    startImageGeneration,
} from '@/lib/generation-services';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';
import {
    estimateGenerationDurationMs,
    getGenerationKind,
    normalizeMarketGenerationTiming,
    normalizeStoredGenerationTiming,
    toIsoTimestamp,
    withGenerationTimingEstimate,
} from '@/lib/generation-timing';
import { withBackendJobLock } from '@/lib/backend-job-lock';
import {
    BackendRateLimitError,
    createBackendRateLimitResponse,
    enforceBackendRateLimit,
    MEDIA_GENERATION_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import {
    buildLockedGenerationStatusPayload,
    GENERATION_PROVIDER_STATUS_RETRY_AFTER_MS,
    GENERATION_STATUS_LOCK_TTL_SECONDS,
    getGenerationStatusLockName,
    getGenerationStatusLockOwner,
    tryAcquireGenerationProviderStatusThrottle,
} from '@/lib/generation-status-lock';
import { CatalogError, quoteGenerationModel } from '@/lib/generation-model-catalog';
import type {
    ImageModelId,
    ImageOutputFormat,
    ImageQualityMode,
    ImageResolution,
} from '@/lib/models';
import { resolveSourceGenerationId, SourceGenerationValidationError } from '@/lib/source-generation';
import {
    GenerationStartIdempotencyError,
    getGenerationStartIdempotencyKey,
    getGenerationStartLockOwner,
    withGenerationStartIdempotency,
} from '@/lib/generation-start-idempotency';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;
const IMAGE_STATUS_GENERATION_SELECT = 'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, workflow_settings';

function getWorkflowSettings(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function getPersistedOutputPaths(workflowSettings: Record<string, unknown> | null): string[] {
    const outputs = workflowSettings?.outputs;
    if (!Array.isArray(outputs)) {
        return [];
    }

    return outputs
        .map((output) => {
            if (!output || typeof output !== 'object') {
                return null;
            }

            const storagePath = (output as Record<string, unknown>).storagePath;
            return typeof storagePath === 'string' && storagePath ? storagePath : null;
        })
        .filter((storagePath): storagePath is string => Boolean(storagePath));
}

async function resolveOutputPaths(adminSupabase: ReturnType<typeof createServiceClient>, outputPaths: string[]): Promise<string[]> {
    return Promise.all(outputPaths.map((outputPath) => resolveStoredMediaUrl(adminSupabase, outputPath)));
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json() as Record<string, unknown>;
        const {
            model = 'nano-banana-2',
            prompt,
            imageUrls = [],
            elements = [],
            aspectRatio = 'auto',
            resolution = '1K',
            qualityMode = 'standard',
            outputFormat = 'jpg',
            googleSearch = false,
            sourceGenerationId = null,
            catalogRevision = null,
        } = body;
        const idempotencyKey = getGenerationStartIdempotencyKey(request, body);
        const selectedModel = typeof model === 'string' ? model : 'nano-banana-2';
        const selectedSourceGenerationId = typeof sourceGenerationId === 'string' ? sourceGenerationId : null;
        const selectedCatalogRevision = typeof catalogRevision === 'string' ? catalogRevision : null;

        // Initialize Supabase client with user context
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: { headers: { Authorization: request.headers.get('Authorization')! } },
            }
        );

        // Get authenticated user
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json(
                { error: 'Unauthorized: Please log in to generate images' },
                { status: 401 }
            );
        }

        if (!KIE_API_KEY) {
            console.error('KIE_AI_API_KEY not found in environment variables');
            return NextResponse.json(
                { error: 'Server configuration error: API key missing' },
                { status: 500 }
            );
        }

        let quote;
        try {
            quote = quoteGenerationModel({
                kind: 'image',
                modelId: selectedModel,
                settings: {
                    aspectRatio,
                    resolution,
                    qualityMode,
                    outputFormat,
                    googleSearch,
                },
                inputCounts: {
                    images: Math.max(
                        Array.isArray(imageUrls) ? imageUrls.length : 0,
                        Array.isArray(elements) ? elements.length : 0
                    ),
                    videos: 0,
                    audios: 0,
                },
                catalogRevision: selectedCatalogRevision,
            });
        } catch (error) {
            if (error instanceof CatalogError) {
                return NextResponse.json({
                    error: error.message,
                    code: error.code,
                    fieldErrors: error.fieldErrors,
                }, { status: error.status });
            }
            throw error;
        }
        const normalizedSettings = quote.normalizedSettings;

        let validatedSourceGenerationId: string | null = null;
        try {
            validatedSourceGenerationId = await resolveSourceGenerationId(supabase, user.id, selectedSourceGenerationId);
        } catch (error) {
            if (error instanceof SourceGenerationValidationError) {
                return NextResponse.json({ error: error.message }, { status: error.status });
            }

            throw error;
        }

        const adminSupabase = createServiceClient();
        await enforceBackendRateLimit(adminSupabase, {
            ...MEDIA_GENERATION_RATE_LIMIT,
            key: user.id,
        });

        const result = await withGenerationStartIdempotency({
            client: adminSupabase,
            userId: user.id,
            idempotencyKey,
            owner: getGenerationStartLockOwner(request),
            start: (clientRequestKeyHash) => startImageGeneration({
                supabase,
                creditSupabase: adminSupabase,
                userId: user.id,
                clientRequestKeyHash,
                model: selectedModel as ImageModelId,
                prompt: typeof prompt === 'string' ? prompt : '',
                imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
                elements: Array.isArray(elements) ? elements : [],
                aspectRatio: String(normalizedSettings.aspectRatio),
                resolution: normalizedSettings.resolution as ImageResolution,
                qualityMode: normalizedSettings.qualityMode as ImageQualityMode | undefined,
                outputFormat: normalizedSettings.outputFormat as ImageOutputFormat,
                googleSearch: Boolean(normalizedSettings.googleSearch),
                sourceGenerationId: validatedSourceGenerationId,
            }),
        });

        return NextResponse.json({
            success: true,
            predictionId: result.predictionId,
            generationId: result.generationId ?? null,
            status: 'processing',
            remainingCredits: result.remainingCredits,
            cost: result.cost,
            ...(result.idempotentReplay ? { idempotentReplay: true } : {}),
        });

    } catch (error: unknown) {
        if (error instanceof GenerationStartIdempotencyError) {
            return NextResponse.json(
                { code: error.code, error: error.message },
                { status: error.status }
            );
        }

        if (error instanceof BackendRateLimitError) {
            return createBackendRateLimitResponse(error);
        }

        console.error('Error starting image generation:', error);
        const message = error instanceof Error ? error.message : 'Failed to start image generation';
        const status = error instanceof GenerationServiceError ? error.status : 500;
        return NextResponse.json(
            { error: message },
            { status }
        );
    }
}

// GET endpoint to check image generation status
export async function GET(request: NextRequest) {
    const startedAt = Date.now();
    const { searchParams } = new URL(request.url);
    const predictionId = searchParams.get('id');

    if (!predictionId) {
        return NextResponse.json({ error: 'Missing prediction ID' }, { status: 400 });
    }

    try {
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: { headers: { Authorization: request.headers.get('Authorization')! } },
            }
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json(
                { error: 'Unauthorized: Please log in to check generation status' },
                { status: 401 }
            );
        }

        // Check local DB cache first
        const { data: localGeneration } = await supabase
            .from('generations')
            .select(IMAGE_STATUS_GENERATION_SELECT)
            .eq('prediction_id', predictionId)
            .eq('user_id', user.id)
            .single();

        if (!localGeneration || localGeneration.user_id !== user.id) {
            return NextResponse.json({ error: 'Generation not found' }, { status: 404 });
        }

        const adminSupabase = createServiceClient();

        if (localGeneration?.status === 'succeeded' && localGeneration?.output_url) {
            const workflowSettings = getWorkflowSettings(localGeneration.workflow_settings);
            const outputPaths = getPersistedOutputPaths(workflowSettings);
            const outputs = outputPaths.length > 0
                ? await resolveOutputPaths(adminSupabase, outputPaths)
                : [];

            return NextResponse.json({
                status: 'succeeded',
                output: await resolveStoredMediaUrl(adminSupabase, localGeneration.output_url),
                ...(outputs.length > 0 ? { outputs } : {}),
                timing: normalizeStoredGenerationTiming({
                    kind: getGenerationKind({
                        category: localGeneration.category,
                        model: localGeneration.model,
                    }),
                    status: localGeneration.status,
                    createdAt: localGeneration.created_at,
                    completedAt: localGeneration.completed_at,
                }),
            });
        }

        if (!KIE_API_KEY) {
            return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
        }

        const workflowSettings = getWorkflowSettings(localGeneration?.workflow_settings);
        const estimatedTotalMs = estimateGenerationDurationMs({
            kind: 'image',
            model: typeof localGeneration?.model === 'string' ? localGeneration.model : null,
            resolution: typeof workflowSettings?.resolution === 'string' ? workflowSettings.resolution : null,
            referenceCount: Array.isArray(workflowSettings?.elements) ? workflowSettings.elements.length : 0,
        });

        const lockOwner = getGenerationStatusLockOwner(request, startedAt);
        const lockResult = await withBackendJobLock(adminSupabase, {
            name: getGenerationStatusLockName(predictionId),
            ttlSeconds: GENERATION_STATUS_LOCK_TTL_SECONDS,
            owner: lockOwner,
        }, async () => {
            const canCheckProvider = await tryAcquireGenerationProviderStatusThrottle(adminSupabase, {
                predictionId,
                owner: lockOwner,
            });

            if (!canCheckProvider) {
                return buildLockedGenerationStatusPayload(
                    localGeneration,
                    estimatedTotalMs,
                    GENERATION_PROVIDER_STATUS_RETRY_AFTER_MS
                );
            }

            // Query Kie.ai for status
            const response = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${predictionId}`, {
                headers: { 'Authorization': `Bearer ${KIE_API_KEY}` },
            });

            const data = await response.json();

            if (!response.ok || data.code !== 200) {
                throw new Error(data.msg || 'Failed to check status');
            }

            const timing = normalizeMarketGenerationTiming({
                kind: 'image',
                task: data.data,
                fallbackStartedAtMs: localGeneration?.created_at ? Date.parse(localGeneration.created_at) : null,
            });
            const timingWithEstimate = withGenerationTimingEstimate(timing, estimatedTotalMs);
            const status = timing.appStatus;
            let output = null;
            let error = null;

            if (status === 'succeeded') {
                try {
                    const result = JSON.parse(data.data.resultJson);
                    const resultUrls = getGenerationResultUrls(result);
                    const tempUrl = resultUrls[0] || null;

                    if (tempUrl) {
                        const userId = user?.id || localGeneration?.user_id;
                        if (!localGeneration?.id || !userId) {
                            throw new Error('Missing local generation record for completed image run');
                        }

                        const persistedOutputs = await persistGeneratedOutputList(
                            supabase,
                            {
                                id: localGeneration.id,
                                user_id: userId,
                                prediction_id: predictionId,
                                category: 'image',
                                model: localGeneration?.model || 'nano-banana-2',
                                workflow_settings: workflowSettings,
                            },
                            localGeneration?.model === 'grok-imagine-image' ? resultUrls : [tempUrl],
                            toIsoTimestamp(timing.completedAtMs)
                        );

                        const resolvedOutputs = await resolveOutputPaths(
                            adminSupabase,
                            persistedOutputs.map((persistedOutput) => persistedOutput.storagePath)
                        );
                        await notifyGenerationStatus(adminSupabase, {
                            id: localGeneration.id,
                            user_id: userId,
                            category: 'image',
                            model: localGeneration?.model || 'nano-banana-2',
                        }, 'succeeded');
                        output = resolvedOutputs[0] || tempUrl;
                        return {
                            status,
                            output,
                            ...(resolvedOutputs.length > 1 ? { outputs: resolvedOutputs } : {}),
                            error,
                            timing: timingWithEstimate,
                        };
                    }
                } catch (e) {
                    console.error('Error handling success status:', e);
                }
            } else if (status === 'failed') {
                error = data.data.failMsg || 'Unknown error';
                await supabase
                    .from('generations')
                    .update({
                        status: 'failed',
                        completed_at: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
                    })
                    .eq('prediction_id', predictionId);

                // Refund credits for async failure (idempotent)
                await adminSupabase.rpc('refund_generation', { p_prediction_id: predictionId });
                if (localGeneration?.id && localGeneration?.user_id) {
                    await notifyGenerationStatus(adminSupabase, {
                        id: localGeneration.id,
                        user_id: localGeneration.user_id,
                        category: localGeneration.category,
                        model: localGeneration.model,
                    }, 'failed');
                }
            }

            return { status, output, error, timing: timingWithEstimate };
        });

        if (!lockResult.acquired) {
            return NextResponse.json(buildLockedGenerationStatusPayload(localGeneration, estimatedTotalMs));
        }

        return NextResponse.json(lockResult.value);

    } catch (error) {
        console.error('Error fetching image status:', error);
        return NextResponse.json({ error: 'Failed to fetch generation status' }, { status: 500 });
    }
}
