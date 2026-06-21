import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
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
import { createGenerationOutputPreview } from '@/lib/generation-media-preview';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';
import { MOTION_MODELS, type MotionModelId } from '@/lib/models';
import { normalizeRemixMediaAssetDescriptor } from '@/lib/remix-source';
import { resolveSourceGenerationId, SourceGenerationValidationError } from '@/lib/source-generation';
import { GenerationServiceError, startMotionGeneration } from '@/lib/generation-services';
import {
    GenerationStartIdempotencyError,
    getGenerationStartIdempotencyKey,
    getGenerationStartLockOwner,
    withGenerationStartIdempotency,
} from '@/lib/generation-start-idempotency';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

export async function POST(request: NextRequest) {
    try {
        const body = await request.json() as Record<string, unknown>;
        const {
            model = 'kling-2.6',
            referenceVideoUrl,
            characterImageUrl,
            duration: requestedDuration = 10,
            characterOrientation: requestedCharacterOrientation = 'video',
            mode: requestedMode = '720p',
            prompt = '',
            characterImage = null,
            referenceVideo = null,
            sourceGenerationId = null,
            catalogRevision = null,
        } = body;
        const idempotencyKey = getGenerationStartIdempotencyKey(request, body);
        const selectedModel = typeof model === 'string' ? model : 'kling-2.6';
        const selectedSourceGenerationId = typeof sourceGenerationId === 'string' ? sourceGenerationId : null;
        const selectedCatalogRevision = typeof catalogRevision === 'string' ? catalogRevision : null;
        const numericRequestedDuration = typeof requestedDuration === 'number'
            ? requestedDuration
            : Number(requestedDuration);
        const safeRequestedDuration = Number.isFinite(numericRequestedDuration)
            ? numericRequestedDuration
            : 10;
        const promptText = typeof prompt === 'string' ? prompt : '';

        if (!referenceVideoUrl || !characterImageUrl) {
            return NextResponse.json(
                { error: 'Missing referenceVideoUrl or characterImageUrl' },
                { status: 400 }
            );
        }

        const modelConfig = MOTION_MODELS[selectedModel as MotionModelId];
        if (!modelConfig) {
            return NextResponse.json(
                { error: `Unsupported model: ${selectedModel}` },
                { status: 400 }
            );
        }

        // Validate Duration
        if (safeRequestedDuration <= 0 || safeRequestedDuration > modelConfig.maxDuration) {
            return NextResponse.json(
                { error: `Invalid duration. Must be between 1 and ${modelConfig.maxDuration} seconds.` },
                { status: 400 }
            );
        }

        if (!KIE_API_KEY) {
            console.error('KIE_AI_API_KEY not found in environment variables');
            return NextResponse.json(
                { error: 'Server configuration error: API key missing' },
                { status: 500 }
            );
        }

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
                { error: 'Unauthorized: Please log in to generate videos' },
                { status: 401 }
            );
        }

        let quote;
        try {
            quote = quoteGenerationModel({
                kind: 'motion',
                modelId: selectedModel,
                settings: {
                    resolution: requestedMode,
                    characterOrientation: requestedCharacterOrientation,
                    duration: safeRequestedDuration,
                },
                inputCounts: { images: 1, videos: 1, audios: 0 },
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
        const duration = Number(quote.normalizedSettings.duration);
        const characterOrientation = String(quote.normalizedSettings.characterOrientation);
        const mode = String(quote.normalizedSettings.resolution);

        let validatedSourceGenerationId: string | null = null;
        try {
            validatedSourceGenerationId = await resolveSourceGenerationId(supabase, user.id, selectedSourceGenerationId);
        } catch (error) {
            if (error instanceof SourceGenerationValidationError) {
                return NextResponse.json({ error: error.message }, { status: error.status });
            }

            throw error;
        }

        const normalizedCharacterImage = normalizeRemixMediaAssetDescriptor(characterImage, 'image');
        const normalizedReferenceVideo = normalizeRemixMediaAssetDescriptor(referenceVideo, 'video');

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
            start: (clientRequestKeyHash) => startMotionGeneration({
                supabase,
                creditSupabase: adminSupabase,
                userId: user.id,
                clientRequestKeyHash,
                model: selectedModel as MotionModelId,
                referenceVideoUrl: typeof referenceVideoUrl === 'string' ? referenceVideoUrl : '',
                characterImageUrl: typeof characterImageUrl === 'string' ? characterImageUrl : '',
                duration,
                characterOrientation: characterOrientation === 'image' ? 'image' : 'video',
                mode: mode === '1080p' ? '1080p' : '720p',
                prompt: promptText,
                sourceGenerationId: validatedSourceGenerationId,
                characterImage: normalizedCharacterImage,
                referenceVideo: normalizedReferenceVideo,
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

        console.error('Error starting video generation:', error);
        const message = error instanceof Error ? error.message : 'Failed to start video generation';
        const status = error instanceof GenerationServiceError ? error.status : 500;
        return NextResponse.json(
            { error: message || 'Failed to start video generation' },
            { status }
        );
    }
}

// GET endpoint to check prediction status
export async function GET(request: NextRequest) {
    const startedAt = Date.now();
    const { searchParams } = new URL(request.url);
    const predictionId = searchParams.get('id');

    if (!predictionId) {
        return NextResponse.json(
            { error: 'Missing prediction ID' },
            { status: 400 }
        );
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

        // 1. Check local database first (Cache hit logic)
        const { data: localGeneration } = await supabase
            .from('generations')
            .select('*')
            .eq('prediction_id', predictionId)
            .single();

        if (!localGeneration || localGeneration.user_id !== user.id) {
            return NextResponse.json({ error: 'Generation not found' }, { status: 404 });
        }

        const adminSupabase = createServiceClient();

        if (localGeneration?.status === 'succeeded' && localGeneration?.output_url) {
            return NextResponse.json({
                status: 'succeeded',
                output: await resolveStoredMediaUrl(adminSupabase, localGeneration.output_url),
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
            return NextResponse.json(
                { error: 'Server configuration error: API key missing' },
                { status: 500 }
            );
        }

        const workflowSettings =
            localGeneration?.workflow_settings && typeof localGeneration.workflow_settings === 'object'
                ? localGeneration.workflow_settings as Record<string, unknown>
                : null;
        const estimatedTotalMs = estimateGenerationDurationMs({
            kind: 'motion',
            model: typeof workflowSettings?.model === 'string' ? workflowSettings.model : null,
            resolution: typeof workflowSettings?.mode === 'string' ? workflowSettings.mode : null,
            durationSeconds: typeof localGeneration?.duration === 'number'
                ? localGeneration.duration
                : typeof workflowSettings?.duration === 'number'
                    ? workflowSettings.duration
                : null,
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

            // 2. Query Kie.ai
            const response = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${predictionId}`, {
                headers: {
                    'Authorization': `Bearer ${KIE_API_KEY}`,
                },
            });

            const data = await response.json();

            if (!response.ok || data.code !== 200) {
                throw new Error(data.msg || 'Failed to check status');
            }

            const timing = normalizeMarketGenerationTiming({
                kind: 'motion',
                task: data.data,
                fallbackStartedAtMs: localGeneration?.created_at ? Date.parse(localGeneration.created_at) : null,
            });
            const status = timing.appStatus;
            let output = null;
            let error = null;

            if (status === 'succeeded') {
                try {
                    const result = JSON.parse(data.data.resultJson);
                    const tempUrl = result.resultUrls?.[0] || null;

                    if (tempUrl) {
                        console.log('Generating finished, persisting video...');
                        const userId = user?.id || localGeneration?.user_id;

                        try {
                            const videoRes = await fetch(tempUrl);
                            if (!videoRes.ok) throw new Error('Failed to download video from Kie');
                            const videoBlob = await videoRes.blob();

                            const fileName = `${userId}/generated_${predictionId}.mp4`;
                            const { error: uploadError } = await supabase.storage
                                .from('generated_videos')
                                .upload(fileName, videoBlob, {
                                    contentType: 'video/mp4',
                                    upsert: true
                                });

                            if (uploadError) {
                                console.error('Upload to Supabase failed:', uploadError);
                                output = tempUrl;
                            } else {
                                // Store the storage path, not a public URL
                                const storagePath = `generated_videos/${fileName}`;
                                let preview: Awaited<ReturnType<typeof createGenerationOutputPreview>> = null;
                                let previewError: string | null = null;
                                try {
                                    preview = await createGenerationOutputPreview({
                                        body: videoBlob,
                                        category: 'video',
                                        contentType: videoBlob.type || 'video/mp4',
                                        storagePath,
                                        supabase,
                                    });
                                } catch (posterError) {
                                    console.error('Failed to create motion generation preview poster:', posterError);
                                    previewError = posterError instanceof Error ? posterError.message.slice(0, 500) : 'Preview generation failed.';
                                }
                                // Generate a signed URL for the client
                                const { data: signedData } = await supabase.storage
                                    .from('generated_videos')
                                    .createSignedUrl(fileName, 3600);
                                output = signedData?.signedUrl || tempUrl;

                                await supabase
                                    .from('generations')
                                    .update({
                                        status: 'succeeded',
                                        output_url: storagePath,
                                        preview_url: preview?.previewStoragePath ?? null,
                                        preview_thumbhash: preview?.previewThumbhash ?? null,
                                        preview_status: preview ? 'ready' : 'failed',
                                        preview_attempt_count: 1,
                                        preview_error: previewError,
                                        preview_generated_at: preview ? new Date().toISOString() : null,
                                        completed_at: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
                                    })
                                    .eq('prediction_id', predictionId);
                            }
                        } catch (e) {
                            console.error('Error persisting video to storage:', e);
                            output = tempUrl;
                        }

                        if (!output || output === tempUrl) {
                            await supabase
                                .from('generations')
                                .update({
                                    status: 'succeeded',
                                    output_url: output,
                                    completed_at: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
                                })
                                .eq('prediction_id', predictionId);
                        }
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
            }

            if (localGeneration?.id && localGeneration?.user_id) {
                if (status === 'succeeded' && output) {
                    await notifyGenerationStatus(adminSupabase, {
                        id: localGeneration.id,
                        user_id: localGeneration.user_id,
                        category: localGeneration.category,
                        model: localGeneration.model,
                    }, 'succeeded');
                } else if (status === 'failed') {
                    await notifyGenerationStatus(adminSupabase, {
                        id: localGeneration.id,
                        user_id: localGeneration.user_id,
                        category: localGeneration.category,
                        model: localGeneration.model,
                    }, 'failed');
                }
            }

            return {
                status,
                output,
                error,
                timing: withGenerationTimingEstimate(timing, estimatedTotalMs),
            };
        });

        if (!lockResult.acquired) {
            return NextResponse.json(buildLockedGenerationStatusPayload(localGeneration, estimatedTotalMs));
        }

        return NextResponse.json(lockResult.value);

    } catch (error) {
        console.error('Error fetching prediction:', error);
        return NextResponse.json(
            { error: 'Failed to fetch prediction status' },
            { status: 500 }
        );
    }
}
