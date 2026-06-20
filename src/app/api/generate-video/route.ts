import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import {
    estimateGenerationDurationMs,
    getGenerationKind,
    normalizeMarketGenerationTiming,
    normalizeStoredGenerationTiming,
    normalizeVeoGenerationTiming,
    toIsoTimestamp,
    withGenerationTimingEstimate,
} from '@/lib/generation-timing';
import { VIDEO_MODELS, VideoModelId } from '@/lib/models';
import { GenerationServiceError, startVideoGeneration } from '@/lib/generation-services';
import { createGenerationOutputPreview } from '@/lib/generation-media-preview';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';
import { resolveSourceGenerationId, SourceGenerationValidationError } from '@/lib/source-generation';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

function buildImageUrls(startImageUrl: string | null, endImageUrl: string | null): string[] {
    const imageUrls: string[] = [];

    if (startImageUrl) {
        imageUrls.push(startImageUrl);
    }

    if (endImageUrl) {
        imageUrls.push(endImageUrl);
    }

    return imageUrls;
}

function getWorkflowModelId(localGeneration: { workflow_settings?: unknown; model?: string } | null): VideoModelId {
    const workflowSettings = localGeneration?.workflow_settings as { model?: string } | null;
    const selectedModel = workflowSettings?.model;

    if (selectedModel && selectedModel in VIDEO_MODELS) {
        return selectedModel as VideoModelId;
    }

    if (localGeneration?.model === 'veo3' || localGeneration?.model === 'veo3_fast') {
        return 'veo-3.1';
    }

    if (localGeneration?.model === 'bytedance/seedance-1.5-pro') {
        return 'seedance-1.5-pro';
    }

    if (localGeneration?.model === 'bytedance/seedance-2') {
        return 'seedance-2';
    }

    if (localGeneration?.model === 'bytedance/seedance-2-fast') {
        return 'seedance-2-fast';
    }

    if (
        localGeneration?.model === 'grok-imagine/text-to-video' ||
        localGeneration?.model === 'grok-imagine/image-to-video'
    ) {
        return 'grok-imagine-video';
    }

    return 'kling-3.0-video';
}

function getFirstResultUrl(value: unknown): string | null {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0] : null;
    }

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
                return parsed[0];
            }
        } catch {
            return value;
        }
    }

    return null;
}

async function persistVideoOutput(
    supabase: SupabaseClient,
    predictionId: string,
    userId: string | undefined,
    tempUrl: string,
    completedAt?: string | null
): Promise<string> {
    try {
        const videoRes = await fetch(tempUrl);
        if (!videoRes.ok) {
            throw new Error('Failed to download video from Kie');
        }

        const videoBlob = await videoRes.blob();
        const fileName = `${userId}/generated_${predictionId}.mp4`;

        const { error: uploadError } = await supabase.storage
            .from('generated_videos')
            .upload(fileName, videoBlob, {
                contentType: 'video/mp4',
                upsert: true,
            });

        if (uploadError) {
            console.error('Upload to Supabase Storage failed:', uploadError);
            await supabase
                .from('generations')
                .update({
                    status: 'succeeded',
                    output_url: tempUrl,
                    completed_at: completedAt ?? new Date().toISOString(),
                })
                .eq('prediction_id', predictionId);
            return tempUrl;
        }

        const storagePath = `generated_videos/${fileName}`;
        let previewUrl: string | null = null;
        try {
            const preview = await createGenerationOutputPreview({
                body: videoBlob,
                category: 'video',
                contentType: videoBlob.type || 'video/mp4',
                storagePath,
                supabase,
            });
            previewUrl = preview?.previewStoragePath ?? null;
        } catch (posterError) {
            console.error('Failed to create video generation preview poster:', posterError);
        }
        const { data: signedData } = await supabase.storage
            .from('generated_videos')
            .createSignedUrl(fileName, 3600);

        await supabase
            .from('generations')
            .update({
                status: 'succeeded',
                output_url: storagePath,
                preview_url: previewUrl,
                completed_at: completedAt ?? new Date().toISOString(),
            })
            .eq('prediction_id', predictionId);

        return signedData?.signedUrl || tempUrl;
    } catch (error) {
        console.error('Error persisting video to storage:', error);
        await supabase
            .from('generations')
            .update({
                status: 'succeeded',
                output_url: tempUrl,
                completed_at: completedAt ?? new Date().toISOString(),
            })
            .eq('prediction_id', predictionId);
        return tempUrl;
    }
}

export async function POST(request: NextRequest) {
    try {
        const {
            model = 'kling-3.0-video',
            isMultiShot,
            prompt,
            multiPrompts,
            elements = [],
            elementImageUrls = [],
            referenceVideoUrls = [],
            referenceAudioUrls = [],
            klingVideoElements = [],
            startImageUrl = null,
            endImageUrl = null,
            mode = 'std',
            aspectRatio = '16:9',
            sound = false,
            duration = 5,
            resolution = '720p',
            fixedLens = false,
            referenceMode = 'frames',
            startFrame = null,
            endFrame = null,
            seedanceAssets = null,
            sourceGenerationId = null,
        } = await request.json();

        if (!KIE_API_KEY) {
            console.error('KIE_AI_API_KEY not found in environment variables');
            return NextResponse.json(
                { error: 'Server configuration error: API key missing' },
                { status: 500 }
            );
        }

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
                { error: 'Unauthorized: Please log in to generate videos' },
                { status: 401 }
            );
        }

        let validatedSourceGenerationId: string | null = null;
        try {
            validatedSourceGenerationId = await resolveSourceGenerationId(supabase, user.id, sourceGenerationId);
        } catch (error) {
            if (error instanceof SourceGenerationValidationError) {
                return NextResponse.json({ error: error.message }, { status: error.status });
            }

            throw error;
        }

        const result = await startVideoGeneration({
            supabase,
            creditSupabase: createServiceClient(),
            userId: user.id,
            model: model as VideoModelId,
            prompt: typeof prompt === 'string' ? prompt : '',
            isMultiShot: Boolean(isMultiShot),
            multiPrompts,
            elements,
            elementImageUrls,
            referenceVideoUrls,
            referenceAudioUrls,
            klingVideoElements,
            startImageUrl,
            endImageUrl,
            imageUrls: buildImageUrls(startImageUrl, endImageUrl),
            mode,
            aspectRatio,
            sound,
            duration,
            resolution,
            fixedLens,
            referenceMode,
            startFrame,
            endFrame,
            seedanceAssets,
            sourceGenerationId: validatedSourceGenerationId,
        });

        return NextResponse.json({
            success: true,
            predictionId: result.predictionId,
            generationId: result.generationId ?? null,
            status: 'processing',
            remainingCredits: result.remainingCredits,
            cost: result.cost,
        });
    } catch (error: unknown) {
        console.error('Error starting video generation:', error);
        const message = error instanceof Error ? error.message : 'Failed to start video generation';
        const status = error instanceof GenerationServiceError ? error.status : 500;
        return NextResponse.json(
            { error: message },
            { status }
        );
    }
}

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const predictionId = searchParams.get('id');

    if (!predictionId) {
        return NextResponse.json({ error: 'Missing prediction ID' }, { status: 400 });
    }

    if (!KIE_API_KEY) {
        return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    try {
        const adminSupabase = createServiceClient();
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: { headers: { Authorization: request.headers.get('Authorization')! } },
            }
        );

        const { data: { user } } = await supabase.auth.getUser();

        const { data: localGeneration } = await supabase
            .from('generations')
            .select('*')
            .eq('prediction_id', predictionId)
            .single();

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

        const selectedModel = getWorkflowModelId(localGeneration);
        const workflowSettings =
            localGeneration?.workflow_settings && typeof localGeneration.workflow_settings === 'object'
                ? localGeneration.workflow_settings as Record<string, unknown>
                : null;
	        const referenceCount =
	            (Array.isArray(workflowSettings?.elements) ? workflowSettings.elements.length : 0) +
	            (Array.isArray(workflowSettings?.referenceVideoUrls) ? workflowSettings.referenceVideoUrls.length : 0) +
	            (Array.isArray(workflowSettings?.referenceAudioUrls) ? workflowSettings.referenceAudioUrls.length : 0) +
	            (Array.isArray(workflowSettings?.klingVideoElements) ? workflowSettings.klingVideoElements.length : 0) +
	            (workflowSettings?.startFrame ? 1 : 0) +
	            (workflowSettings?.endFrame ? 1 : 0);
	        const hasReferenceVideo =
	            (Array.isArray(workflowSettings?.referenceVideoUrls) && workflowSettings.referenceVideoUrls.length > 0) ||
	            (Array.isArray(workflowSettings?.klingVideoElements) && workflowSettings.klingVideoElements.length > 0);
	        const estimatedTotalMs = estimateGenerationDurationMs({
            kind: 'video',
            model: selectedModel,
            mode: typeof workflowSettings?.mode === 'string' ? workflowSettings.mode : null,
            resolution: typeof workflowSettings?.resolution === 'string' ? workflowSettings.resolution : null,
            durationSeconds: typeof localGeneration?.duration === 'number'
                ? localGeneration.duration
                : typeof workflowSettings?.duration === 'number'
                    ? workflowSettings.duration
                    : null,
            isMultiShot: typeof workflowSettings?.isMultiShot === 'boolean' ? workflowSettings.isMultiShot : null,
            shotCount: Array.isArray(workflowSettings?.multiPrompts) ? workflowSettings.multiPrompts.length : null,
            referenceCount,
            hasSound: typeof workflowSettings?.sound === 'boolean' ? workflowSettings.sound : null,
	            hasReferenceVideo,
	        });
        let status: 'processing' | 'waiting' | 'succeeded' | 'failed' = 'processing';
        let output: string | null = null;
        let error: string | null = null;
        let timing = normalizeStoredGenerationTiming({
            kind: getGenerationKind({
                category: localGeneration?.category,
                model: localGeneration?.model,
            }),
            status: localGeneration?.status,
            createdAt: localGeneration?.created_at,
            completedAt: localGeneration?.completed_at,
        });

        if (selectedModel === 'veo-3.1') {
            const response = await fetch(`https://api.kie.ai/api/v1/veo/record-info?taskId=${predictionId}`, {
                headers: { Authorization: `Bearer ${KIE_API_KEY}` },
            });

            const data = await response.json();

            if (!response.ok || data.code !== 200) {
                throw new Error(data.msg || 'Failed to check status');
            }

            const successFlag = data.data?.successFlag;
            const responseData = data.data?.response;
            timing = normalizeVeoGenerationTiming({
                kind: 'video',
                task: data.data,
                fallbackStartedAtMs: localGeneration?.created_at ? Date.parse(localGeneration.created_at) : null,
            });
            status = timing.appStatus;

            if (successFlag === 1) {
                const tempUrl = getFirstResultUrl(responseData?.resultUrls) || getFirstResultUrl(responseData?.originUrls);

                if (tempUrl) {
                    output = await persistVideoOutput(
                        supabase,
                        predictionId,
                        user?.id || localGeneration?.user_id,
                        tempUrl,
                        toIsoTimestamp(timing.completedAtMs)
                    );
                }
            } else if (successFlag === 2 || successFlag === 3) {
                error = data.data?.errorMessage || data.msg || 'Unknown error';
                await supabase
                    .from('generations')
                    .update({
                        status: 'failed',
                        completed_at: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
                    })
                    .eq('prediction_id', predictionId);
                await adminSupabase.rpc('refund_generation', { p_prediction_id: predictionId });
            }
        } else {
            const response = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${predictionId}`, {
                headers: { Authorization: `Bearer ${KIE_API_KEY}` },
            });

            const data = await response.json();

            if (!response.ok || data.code !== 200) {
                throw new Error(data.msg || 'Failed to check status');
            }

            timing = normalizeMarketGenerationTiming({
                kind: 'video',
                task: data.data,
                fallbackStartedAtMs: localGeneration?.created_at ? Date.parse(localGeneration.created_at) : null,
            });
            status = timing.appStatus;

            if (status === 'succeeded') {
                try {
                    const result = JSON.parse(data.data.resultJson);
                    const tempUrl = getFirstResultUrl(result.resultUrls);

                    if (tempUrl) {
                        output = await persistVideoOutput(
                            supabase,
                            predictionId,
                            user?.id || localGeneration?.user_id,
                            tempUrl,
                            toIsoTimestamp(timing.completedAtMs)
                        );
                    }
                } catch (parseError) {
                    console.error('Error handling success status:', parseError);
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
                await adminSupabase.rpc('refund_generation', { p_prediction_id: predictionId });
            }
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

        return NextResponse.json({
            status,
            output,
            error,
            timing: withGenerationTimingEstimate(timing, estimatedTotalMs),
        });
    } catch (error) {
        console.error('Error fetching video status:', error);
        return NextResponse.json({ error: 'Failed to fetch generation status' }, { status: 500 });
    }
}
