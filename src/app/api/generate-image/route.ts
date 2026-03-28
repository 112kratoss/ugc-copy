import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import {
    compileImagePromptWithElements,
    findUnknownPromptHandles,
    normalizeSubmittedElementDescriptors,
} from '@/lib/image-elements';
import { resolveSourceGenerationId, SourceGenerationValidationError } from '@/lib/source-generation';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

// Supported models and their constraints
const MODEL_CONFIG: Record<string, { maxImages: number; supportsGoogleSearch: boolean }> = {
    'nano-banana-2': { maxImages: 14, supportsGoogleSearch: true },
    'nano-banana-pro': { maxImages: 8, supportsGoogleSearch: false },
};

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
            model = 'nano-banana-2',
            prompt,
            imageUrls = [],
            elements = [],
            aspectRatio = 'auto',
            resolution = '1K',
            outputFormat = 'jpg',
            googleSearch = false,
            sourceGenerationId = null,
        } = await request.json();

        if (!prompt || prompt.trim().length === 0) {
            return NextResponse.json(
                { error: 'A prompt is required to generate an image' },
                { status: 400 }
            );
        }

        const modelConfig = MODEL_CONFIG[model];
        if (!modelConfig) {
            return NextResponse.json(
                { error: `Unsupported model: ${model}` },
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

        // Calculate cost based on model and resolution
        let cost = 8;
        if (model === 'nano-banana-pro') {
            cost = resolution === '4K' ? 24 : 18;
        } else {
            // nano-banana-2
            if (resolution === '2K') cost = 12;
            if (resolution === '4K') cost = 18;
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
                { error: 'Unauthorized: Please log in to generate images' },
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

        // Deduct Credits
        const { data: remainingCredits, error: creditError } = await supabase.rpc('deduct_credits', {
            p_user_id: user.id,
            p_cost: cost
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
                { error: `Insufficient credits. Image generation at ${resolution} costs ${cost} credits.` },
                { status: 402 }
            );
        }

        refundState = {
            supabase,
            userId: user.id,
            amount: cost,
            shouldRefund: true,
        };

        const clampedImageUrls = Array.isArray(imageUrls)
            ? imageUrls.filter((url): url is string => typeof url === 'string' && url.length > 0).slice(0, modelConfig.maxImages)
            : [];
        const normalizedElements = normalizeSubmittedElementDescriptors(elements).slice(0, modelConfig.maxImages);
        const alignedElements = normalizedElements.slice(0, clampedImageUrls.length);
        const trimmedPrompt = prompt.trim();
        const unknownPromptHandles = findUnknownPromptHandles(trimmedPrompt, alignedElements.map((element) => element.handle));

        if (unknownPromptHandles.length > 0) {
            return NextResponse.json(
                { error: `Unknown element mention${unknownPromptHandles.length > 1 ? 's' : ''}: ${unknownPromptHandles.join(', ')}` },
                { status: 400 }
            );
        }

        if (normalizedElements.length > 0 && clampedImageUrls.length !== normalizedElements.length) {
            return NextResponse.json(
                { error: 'Element metadata does not match the uploaded element images.' },
                { status: 400 }
            );
        }

        const compiledPrompt = compileImagePromptWithElements(trimmedPrompt, alignedElements);

        // Build input object — model-specific
        const input: Record<string, unknown> = {
            prompt: compiledPrompt,
            aspect_ratio: aspectRatio,
            resolution,
            output_format: outputFormat,
        };

        // Add google_search grounding only where supported
        if (modelConfig.supportsGoogleSearch) {
            input.google_search = googleSearch;
        }

        // Clamp reference images to model's limit
        if (clampedImageUrls.length > 0) {
            input.image_input = clampedImageUrls;
        }

        // Call Kie.ai API
        const response = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${KIE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ model, input })
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

        // Log Generation
        const { data: generationRecord, error: logError } = await supabase
            .from('generations')
            .insert({
                user_id: user.id,
                model,
                cost,
                prediction_id: taskId,
                status: 'processing',
                prompt: trimmedPrompt,
                category: 'image',
                source_generation_id: validatedSourceGenerationId,
                workflow_settings: {
                    model,
                    aspectRatio,
                    resolution,
                    outputFormat,
                    googleSearch,
                    ...(alignedElements.length > 0
                        ? {
                            elements: alignedElements,
                            promptMode: 'element-mentions-v1' as const,
                            compiledPrompt,
                        }
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
        });

    } catch (error: unknown) {
        await refundIfNeeded();
        console.error('Error starting image generation:', error);
        const message = error instanceof Error ? error.message : 'Failed to start image generation';
        return NextResponse.json(
            { error: message },
            { status: 500 }
        );
    }
}

// GET endpoint to check image generation status
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

        // Get authenticated user for storage scoping
        const { data: { user } } = await supabase.auth.getUser();

        // Check local DB cache first
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

        // Query Kie.ai for status
        const response = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${predictionId}`, {
            headers: { 'Authorization': `Bearer ${KIE_API_KEY}` },
        });

        const data = await response.json();

        if (!response.ok || data.code !== 200) {
            throw new Error(data.msg || 'Failed to check status');
        }

        let status = data.data.state;
        let output = null;
        let error = null;

        if (status === 'success') {
            status = 'succeeded';
            try {
                const result = JSON.parse(data.data.resultJson);
                const tempUrl = result.resultUrls?.[0] || null;

                if (tempUrl) {
                    // Persist image to Supabase Storage
                    const userId = user?.id || localGeneration?.user_id;
                    try {
                        const imgRes = await fetch(tempUrl);
                        if (!imgRes.ok) throw new Error('Failed to download image from Kie');
                        const imgBlob = await imgRes.blob();
                        const ext = imgBlob.type.includes('png') ? 'png' : 'jpg';
                        const fileName = `${userId}/generated_${predictionId}.${ext}`;

                        const { error: uploadError } = await supabase.storage
                            .from('generated_images')
                            .upload(fileName, imgBlob, {
                                contentType: imgBlob.type,
                                upsert: true
                            });

                        if (uploadError) {
                            console.error('Upload to Supabase Storage failed:', uploadError);
                            output = tempUrl;
                        } else {
                            // Store the storage path, not a public URL
                            const storagePath = `generated_images/${fileName}`;
                            const { data: signedData } = await supabase.storage
                                .from('generated_images')
                                .createSignedUrl(fileName, 3600);
                            output = signedData?.signedUrl || tempUrl;

                            await supabase
                                .from('generations')
                                .update({ status: 'succeeded', output_url: storagePath })
                                .eq('prediction_id', predictionId);
                        }
                    } catch (e) {
                        console.error('Error persisting image to storage:', e);
                        output = tempUrl;
                    }

                    // Update DB if we fell back to tempUrl
                    if (!output || output === tempUrl) {
                        await supabase
                            .from('generations')
                            .update({ status: 'succeeded', output_url: output })
                            .eq('prediction_id', predictionId);
                    }
                }
            } catch (e) {
                console.error('Error handling success status:', e);
            }
        } else if (status === 'fail') {
            status = 'failed';
            error = data.data.failMsg || 'Unknown error';
            await supabase
                .from('generations')
                .update({ status: 'failed' })
                .eq('prediction_id', predictionId);

            // Refund credits for async failure (idempotent)
            await supabase.rpc('refund_generation', { p_prediction_id: predictionId });
        }

        return NextResponse.json({ status, output, error });

    } catch (error) {
        console.error('Error fetching image status:', error);
        return NextResponse.json({ error: 'Failed to fetch generation status' }, { status: 500 });
    }
}
