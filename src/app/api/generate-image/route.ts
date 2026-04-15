import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import { GenerationServiceError, startImageGeneration } from '@/lib/generation-services';
import {
    getGenerationKind,
    normalizeMarketGenerationTiming,
    normalizeStoredGenerationTiming,
    toIsoTimestamp,
} from '@/lib/generation-timing';
import { resolveSourceGenerationId, SourceGenerationValidationError } from '@/lib/source-generation';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

export async function POST(request: NextRequest) {
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

        const result = await startImageGeneration({
            supabase,
            userId: user.id,
            model,
            prompt,
            imageUrls,
            elements,
            aspectRatio,
            resolution,
            outputFormat,
            googleSearch,
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
        let status = timing.appStatus;
        let output = null;
        let error = null;

        if (status === 'succeeded') {
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
                                .update({
                                    status: 'succeeded',
                                    output_url: storagePath,
                                    completed_at: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
                                })
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
            await supabase.rpc('refund_generation', { p_prediction_id: predictionId });
        }

        return NextResponse.json({ status, output, error, timing });

    } catch (error) {
        console.error('Error fetching image status:', error);
        return NextResponse.json({ error: 'Failed to fetch generation status' }, { status: 500 });
    }
}
