import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import { getVideoCost, getVideoElementSupport, isValidVideoDuration, VIDEO_MODELS, VideoModelId } from '@/lib/models';
import {
    compilePromptWithElements,
    findUnknownPromptHandles,
    normalizeSubmittedElementDescriptors,
} from '@/lib/image-elements';
import { normalizeRemixMediaAssetDescriptor } from '@/lib/remix-source';
import { resolveSourceGenerationId, SourceGenerationValidationError } from '@/lib/source-generation';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

type MultiPrompt = {
    id?: string;
    prompt: string;
    duration: number;
};

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
    tempUrl: string
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
                .update({ status: 'succeeded', output_url: tempUrl })
                .eq('prediction_id', predictionId);
            return tempUrl;
        }

        const storagePath = `generated_videos/${fileName}`;
        const { data: signedData } = await supabase.storage
            .from('generated_videos')
            .createSignedUrl(fileName, 3600);

        await supabase
            .from('generations')
            .update({ status: 'succeeded', output_url: storagePath })
            .eq('prediction_id', predictionId);

        return signedData?.signedUrl || tempUrl;
    } catch (error) {
        console.error('Error persisting video to storage:', error);
        await supabase
            .from('generations')
            .update({ status: 'succeeded', output_url: tempUrl })
            .eq('prediction_id', predictionId);
        return tempUrl;
    }
}

export async function POST(request: NextRequest) {
    let refundState: {
        supabase: SupabaseClient;
        userId: string;
        amount: number;
        shouldRefund: boolean;
    } | null = null;

    const refundIfNeeded = async () => {
        if (!refundState?.shouldRefund) return;

        await refundState.supabase.rpc('refund_credits', {
            p_user_id: refundState.userId,
            p_amount: refundState.amount,
        });
        refundState.shouldRefund = false;
    };

    try {
        const {
            model = 'kling-3.0-video',
            isMultiShot,
            prompt,
            multiPrompts,
            elements = [],
            elementImageUrls = [],
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
            sourceGenerationId = null,
        } = await request.json();

        if (!(model in VIDEO_MODELS)) {
            return NextResponse.json({ error: `Unsupported video model: ${model}` }, { status: 400 });
        }

        const selectedModel = VIDEO_MODELS[model as VideoModelId];
        const soundEnabled = selectedModel.supportsSound ? sound : false;
        const frameImageUrls = buildImageUrls(startImageUrl, endImageUrl);
        const normalizedElements = normalizeSubmittedElementDescriptors(elements);
        const videoElementSupport = getVideoElementSupport(model as VideoModelId, { mode, isMultiShot });
        const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
        const normalizedReferenceMode = referenceMode === 'elements' ? 'elements' : 'frames';
        const normalizedStartFrame = normalizeRemixMediaAssetDescriptor(startFrame, 'image');
        const normalizedEndFrame = normalizeRemixMediaAssetDescriptor(endFrame, 'image');

        if (isMultiShot && !selectedModel.supportsMultiShot) {
            return NextResponse.json({ error: `${selectedModel.displayName} does not support multi-shot generation.` }, { status: 400 });
        }

        if (isMultiShot) {
            if (!multiPrompts || multiPrompts.length === 0) {
                return NextResponse.json({ error: 'At least one shot is required for multi-shot mode' }, { status: 400 });
            }

            for (const shot of multiPrompts as MultiPrompt[]) {
                if (!shot.prompt || shot.prompt.trim().length === 0) {
                    return NextResponse.json({ error: 'All shots must have a text prompt' }, { status: 400 });
                }
            }
        } else if (!trimmedPrompt) {
            return NextResponse.json({ error: 'A prompt is required for video generation' }, { status: 400 });
        }

        if (normalizedElements.length > 0 && !videoElementSupport.enabled) {
            return NextResponse.json(
                { error: videoElementSupport.reason || 'Named elements are not available in this video mode.' },
                { status: 400 }
            );
        }

        if (normalizedElements.length > videoElementSupport.maxElements) {
            return NextResponse.json(
                { error: `This video mode supports up to ${videoElementSupport.maxElements} named element${videoElementSupport.maxElements === 1 ? '' : 's'}.` },
                { status: 400 }
            );
        }

        if (normalizedElements.length > 0 && frameImageUrls.length > 0) {
            return NextResponse.json(
                { error: 'Named elements cannot be combined with start or end frames in the same run.' },
                { status: 400 }
            );
        }

        const clampedElementImageUrls = Array.isArray(elementImageUrls)
            ? elementImageUrls.filter((url): url is string => typeof url === 'string' && url.length > 0).slice(0, videoElementSupport.maxElements)
            : [];

        if (normalizedElements.length > 0 && normalizedElements.length !== clampedElementImageUrls.length) {
            return NextResponse.json(
                { error: 'Element metadata does not match the uploaded video element images.' },
                { status: 400 }
            );
        }

        const unknownPromptHandles = findUnknownPromptHandles(
            trimmedPrompt,
            normalizedElements.map((element) => element.handle)
        );

        if (unknownPromptHandles.length > 0) {
            return NextResponse.json(
                { error: `Unknown element mention${unknownPromptHandles.length > 1 ? 's' : ''}: ${unknownPromptHandles.join(', ')}` },
                { status: 400 }
            );
        }

        const compiledPrompt = normalizedElements.length > 0
            ? compilePromptWithElements(trimmedPrompt, normalizedElements, 'video')
            : trimmedPrompt;
        const effectiveReferenceMode = normalizedElements.length > 0
            ? 'elements'
            : frameImageUrls.length > 0
                ? 'frames'
                : normalizedReferenceMode;

        if (!(selectedModel.aspectRatios as readonly string[]).includes(aspectRatio)) {
            return NextResponse.json({ error: `Unsupported aspect ratio for ${selectedModel.displayName}` }, { status: 400 });
        }

        if (selectedModel.modeOptions.length > 0 && !selectedModel.modeOptions.some((option) => option.value === mode)) {
            return NextResponse.json({ error: `Unsupported mode for ${selectedModel.displayName}` }, { status: 400 });
        }

        if (selectedModel.resolutions.length > 0 && !(selectedModel.resolutions as readonly string[]).includes(resolution)) {
            return NextResponse.json({ error: `Unsupported resolution for ${selectedModel.displayName}` }, { status: 400 });
        }

        if (!isMultiShot && selectedModel.provider !== 'veo' && !isValidVideoDuration(model as VideoModelId, duration)) {
            return NextResponse.json({ error: `Unsupported duration for ${selectedModel.displayName}` }, { status: 400 });
        }

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

        const totalDuration = isMultiShot
            ? (multiPrompts as MultiPrompt[]).reduce((acc, curr) => acc + (curr.duration || 3), 0)
            : (selectedModel.provider === 'veo' ? selectedModel.durations[0] : duration);

        const cost = getVideoCost(model as VideoModelId, {
            mode,
            sound: soundEnabled,
            durationSeconds: totalDuration,
            resolution,
        });

        const { data: remainingCredits, error: creditError } = await supabase.rpc('deduct_credits', {
            p_user_id: user.id,
            p_cost: cost,
        });

        if (creditError) {
            console.error('Error checking credits:', creditError);
            return NextResponse.json({
                error: 'Failed to verify credits',
                details: creditError.message,
            }, { status: 500 });
        }

        if (remainingCredits === -1) {
            return NextResponse.json(
                { error: `Insufficient credits. This generation costs ${cost} credits.` },
                { status: 402 }
            );
        }

        refundState = {
            supabase,
            userId: user.id,
            amount: cost,
            shouldRefund: true,
        };

        let endpoint = 'https://api.kie.ai/api/v1/jobs/createTask';
        let body: Record<string, unknown>;
        let providerModelId: string = selectedModel.apiModelId || mode;
        const referenceImageUrls = normalizedElements.length > 0 ? clampedElementImageUrls : [];

        if (selectedModel.provider === 'kling') {
            const input: Record<string, unknown> = {
                mode,
                aspect_ratio: aspectRatio,
                sound: soundEnabled,
                multi_shots: Boolean(isMultiShot),
                duration: String(totalDuration),
            };

            if (isMultiShot) {
                input.multi_prompt = (multiPrompts as MultiPrompt[]).map((shot) => ({
                    prompt: shot.prompt.trim(),
                    duration: shot.duration,
                }));
            } else {
                input.prompt = compiledPrompt;
            }

            if (frameImageUrls.length > 0) {
                input.image_urls = frameImageUrls;
            }

            body = {
                model: selectedModel.apiModelId,
                input,
            };
        } else if (selectedModel.provider === 'seedance') {
            const input: Record<string, unknown> = {
                prompt: compiledPrompt,
                aspect_ratio: aspectRatio,
                resolution,
                duration: String(duration),
                fixed_lens: fixedLens,
                generate_audio: soundEnabled,
            };

            if (referenceImageUrls.length > 0) {
                input.input_urls = referenceImageUrls;
            } else if (frameImageUrls.length > 0) {
                input.input_urls = frameImageUrls;
            }

            body = {
                model: selectedModel.apiModelId,
                input,
            };
        } else {
            endpoint = 'https://api.kie.ai/api/v1/veo/generate';
            providerModelId = mode === 'veo3' ? 'veo3' : 'veo3_fast';

            body = {
                prompt: compiledPrompt,
                model: providerModelId,
                aspectRatio,
                generationType: referenceImageUrls.length > 0
                    ? 'REFERENCE_2_VIDEO'
                    : (frameImageUrls.length > 0 ? 'FIRST_AND_LAST_FRAMES_2_VIDEO' : 'TEXT_2_VIDEO'),
                ...(referenceImageUrls.length > 0
                    ? { imageUrls: referenceImageUrls }
                    : (frameImageUrls.length > 0 ? { imageUrls: frameImageUrls } : {})),
            };
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${KIE_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        let data;
        try {
            data = await response.json();
        } catch {
            console.error('Kie.ai returned non-JSON response — refunding credits');
            await refundIfNeeded();
            return NextResponse.json({ error: 'Provider returned an invalid response' }, { status: 502 });
        }

        if (!response.ok || data.code !== 200) {
            console.error('Kie.ai API rejected request — refunding credits', data);
            await refundIfNeeded();
            return NextResponse.json(
                { error: data.msg || 'Provider rejected the request' },
                { status: 502 }
            );
        }

        const taskId = data.data.taskId;
        refundState.shouldRefund = false;
        const remixMultiPrompts = isMultiShot
            ? (multiPrompts as MultiPrompt[]).map((shot, index) => ({
                id: shot.id || `${index + 1}`,
                prompt: shot.prompt.trim(),
                duration: shot.duration,
            }))
            : undefined;

        const { data: generationRecord, error: logError } = await supabase
            .from('generations')
            .insert({
                user_id: user.id,
                model: providerModelId,
                cost,
                duration: totalDuration,
                prediction_id: taskId,
                status: 'processing',
                prompt: isMultiShot ? ((multiPrompts as MultiPrompt[])?.[0]?.prompt || '') : trimmedPrompt,
                category: 'video',
                source_generation_id: validatedSourceGenerationId,
                workflow_settings: {
                    model,
                    mode,
                    aspectRatio,
                    sound: soundEnabled,
                    duration: totalDuration,
                    multiPrompts: remixMultiPrompts,
                    resolution,
                    fixedLens,
                    referenceMode: effectiveReferenceMode,
                    ...(normalizedElements.length > 0
                        ? {
                            elements: normalizedElements,
                            promptMode: 'element-mentions-v1' as const,
                            compiledPrompt,
                        }
                        : {}),
                    ...(effectiveReferenceMode === 'frames' && normalizedStartFrame
                        ? { startFrame: normalizedStartFrame }
                        : {}),
                    ...(effectiveReferenceMode === 'frames' && normalizedEndFrame
                        ? { endFrame: normalizedEndFrame }
                        : {}),
                },
            })
            .select('id')
            .single();

        if (logError) {
            console.error('Error logging generation:', logError);
        }

        return NextResponse.json({
            success: true,
            predictionId: taskId,
            generationId: generationRecord?.id ?? null,
            status: 'processing',
            remainingCredits,
            cost,
        });
    } catch (error: unknown) {
        await refundIfNeeded();
        console.error('Error starting video generation:', error);
        const message = error instanceof Error ? error.message : 'Failed to start video generation';
        return NextResponse.json(
            { error: message },
            { status: 500 }
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
            });
        }

        const selectedModel = getWorkflowModelId(localGeneration);
        let status = 'processing';
        let output: string | null = null;
        let error: string | null = null;

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

            if (successFlag === 1) {
                status = 'succeeded';
                const tempUrl = getFirstResultUrl(responseData?.resultUrls) || getFirstResultUrl(responseData?.originUrls);

                if (tempUrl) {
                    output = await persistVideoOutput(
                        supabase,
                        predictionId,
                        user?.id || localGeneration?.user_id,
                        tempUrl
                    );
                }
            } else if (successFlag === 2 || successFlag === 3) {
                status = 'failed';
                error = data.data?.errorMessage || data.msg || 'Unknown error';
                await supabase
                    .from('generations')
                    .update({ status: 'failed' })
                    .eq('prediction_id', predictionId);
                await supabase.rpc('refund_generation', { p_prediction_id: predictionId });
            }
        } else {
            const response = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${predictionId}`, {
                headers: { Authorization: `Bearer ${KIE_API_KEY}` },
            });

            const data = await response.json();

            if (!response.ok || data.code !== 200) {
                throw new Error(data.msg || 'Failed to check status');
            }

            status = data.data.state;

            if (status === 'success') {
                status = 'succeeded';

                try {
                    const result = JSON.parse(data.data.resultJson);
                    const tempUrl = getFirstResultUrl(result.resultUrls);

                    if (tempUrl) {
                        output = await persistVideoOutput(
                            supabase,
                            predictionId,
                            user?.id || localGeneration?.user_id,
                            tempUrl
                        );
                    }
                } catch (parseError) {
                    console.error('Error handling success status:', parseError);
                }
            } else if (status === 'fail') {
                status = 'failed';
                error = data.data.failMsg || 'Unknown error';
                await supabase
                    .from('generations')
                    .update({ status: 'failed' })
                    .eq('prediction_id', predictionId);
                await supabase.rpc('refund_generation', { p_prediction_id: predictionId });
            }
        }

        return NextResponse.json({ status, output, error });
    } catch (error) {
        console.error('Error fetching video status:', error);
        return NextResponse.json({ error: 'Failed to fetch generation status' }, { status: 500 });
    }
}
