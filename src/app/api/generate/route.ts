import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import { resolveSourceGenerationId, SourceGenerationValidationError } from '@/lib/source-generation';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

// ─── Model Config Registry ───────────────────────────────────────────────────
const MOTION_MODEL_CONFIG: Record<string, { modelId: string; maxDuration: number }> = {
    'kling-2.6': { modelId: 'kling-2.6/motion-control', maxDuration: 30 },
    'kling-3.0': { modelId: 'kling-3.0/motion-control', maxDuration: 30 },
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
            model = 'kling-2.6',
            referenceVideoUrl,
            characterImageUrl,
            duration = 10,
            characterOrientation = 'video',
            mode = '720p',
            prompt = '',
            sourceGenerationId = null,
        } = await request.json();

        if (!referenceVideoUrl || !characterImageUrl) {
            return NextResponse.json(
                { error: 'Missing referenceVideoUrl or characterImageUrl' },
                { status: 400 }
            );
        }

        const modelConfig = MOTION_MODEL_CONFIG[model];
        if (!modelConfig) {
            return NextResponse.json(
                { error: `Unsupported model: ${model}` },
                { status: 400 }
            );
        }

        // Validate Duration
        if (duration <= 0 || duration > modelConfig.maxDuration) {
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

        let validatedSourceGenerationId: string | null = null;
        try {
            validatedSourceGenerationId = await resolveSourceGenerationId(supabase, user.id, sourceGenerationId);
        } catch (error) {
            if (error instanceof SourceGenerationValidationError) {
                return NextResponse.json({ error: error.message }, { status: error.status });
            }

            throw error;
        }

        // Calculate Cost Dynamically
        let creditsPerSecond = 0;
        if (model === 'kling-3.0') {
            creditsPerSecond = mode === '1080p' ? 20 : 12;
        } else {
            // kling-2.6
            creditsPerSecond = mode === '1080p' ? 9 : 6;
        }
        
        const COST = Math.ceil(duration * creditsPerSecond);

        // Deduct Credits
        const { data: remainingCredits, error: creditError } = await supabase.rpc('deduct_credits', {
            p_user_id: user.id,
            p_cost: COST
        });

        if (creditError) {
            console.error('Error checking credits:', creditError);
            return NextResponse.json({
                error: 'Failed to verify credits',
                details: creditError.message,
                hint: creditError.hint,
                code: creditError.code
            }, { status: 500 });
        }

        if (remainingCredits === -1) {
            return NextResponse.json(
                { error: `Insufficient credits. This generation costs ${COST} credits.` },
                { status: 402 }
            );
        }

        refundState = {
            supabase,
            userId: user.id,
            amount: COST,
            shouldRefund: true,
        };

        // Build webhook callback URL
        const webhookSecret = process.env.WEBHOOK_SECRET ?? 'kd92mxp4n7qbt1ej';
        const callBackUrl = `https://ildfmhozpibwiopeavfg.supabase.co/functions/v1/kie-webhook?secret=${webhookSecret}`;

        const response = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${KIE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: modelConfig.modelId,
                callBackUrl,
                input: {
                    prompt: prompt.trim() || "The cartoon character is dancing.",
                    input_urls: [characterImageUrl],
                    video_urls: [referenceVideoUrl],
                    character_orientation: characterOrientation,
                    mode: mode
                }
            })
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

        // Log Generation with the model key (e.g. 'kling-3.0')
        const { data: generationRecord, error: logError } = await supabase
            .from('generations')
            .insert({
                user_id: user.id,
                model: modelConfig.modelId,
                duration: duration,
                cost: COST,
                prediction_id: taskId,
                status: 'processing',
                prompt: (prompt || '').trim(),
                category: 'motion',
                source_generation_id: validatedSourceGenerationId,
                workflow_settings: {
                    model,
                    characterOrientation,
                    mode,
                    duration,
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
            remainingCredits: remainingCredits
        });

    } catch (error: unknown) {
        await refundIfNeeded();
        console.error('Error starting video generation:', error);
        const message = error instanceof Error ? error.message : 'Failed to start video generation';
        return NextResponse.json(
            { error: message || 'Failed to start video generation' },
            { status: 500 }
        );
    }
}

// GET endpoint to check prediction status
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const predictionId = searchParams.get('id');

    if (!predictionId) {
        return NextResponse.json(
            { error: 'Missing prediction ID' },
            { status: 400 }
        );
    }

    if (!KIE_API_KEY) {
        return NextResponse.json(
            { error: 'Server configuration error: API key missing' },
            { status: 500 }
        );
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

        // 1. Check local database first (Cache hit logic)
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

        let status = data.data.state;
        let output = null;
        let error = null;

        if (status === 'success') {
            status = 'succeeded';
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
                            // Generate a signed URL for the client
                            const { data: signedData } = await supabase.storage
                                .from('generated_videos')
                                .createSignedUrl(fileName, 3600);
                            output = signedData?.signedUrl || tempUrl;

                            await supabase
                                .from('generations')
                                .update({ status: 'succeeded', output_url: storagePath })
                                .eq('prediction_id', predictionId);
                        }
                    } catch (e) {
                        console.error('Error persisting video to storage:', e);
                        output = tempUrl;
                    }

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
        console.error('Error fetching prediction:', error);
        return NextResponse.json(
            { error: 'Failed to fetch prediction status' },
            { status: 500 }
        );
    }
}
