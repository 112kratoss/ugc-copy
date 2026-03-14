import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient, signStoredMediaUrl } from '@/lib/server-helpers';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

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
            isMultiShot,
            prompt,
            multiPrompts,
            startImageUrl = null,
            endImageUrl = null,
            mode = 'std',
            aspectRatio = '16:9',
            sound = false,
            duration = 5 // for single shot
        } = await request.json();

        // Validation
        if (isMultiShot) {
            if (!multiPrompts || multiPrompts.length === 0) {
                return NextResponse.json({ error: 'At least one shot is required for multi-shot mode' }, { status: 400 });
            }
            for (const shot of multiPrompts) {
                if (!shot.prompt || shot.prompt.trim().length === 0) {
                    return NextResponse.json({ error: 'All shots must have a text prompt' }, { status: 400 });
                }
            }
        } else {
            if (!prompt || prompt.trim().length === 0) {
                return NextResponse.json({ error: 'A prompt is required for single shot video' }, { status: 400 });
            }
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

        // Calculate Cost Dynamically (Kling 3.0 tokens per second)
        let creditsPerSecond = 20; // std, no audio
        if (mode === 'std' && sound) creditsPerSecond = 30;
        if (mode === 'pro' && !sound) creditsPerSecond = 27;
        if (mode === 'pro' && sound) creditsPerSecond = 40;
        let totalDuration = duration;
        if (isMultiShot) {
            totalDuration = multiPrompts.reduce((acc: number, curr: { duration?: number }) => acc + (curr.duration || 3), 0);
        }
        const COST = Math.ceil(totalDuration * creditsPerSecond);

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

        // Build input object for Kling 3.0
        const input: Record<string, unknown> = {
            mode: mode,
            aspect_ratio: aspectRatio,
            sound: sound,
        };

        if (isMultiShot) {
            input.multi_shots = true;
            input.multi_prompt = multiPrompts.map((p: { prompt: string; duration: number }) => ({
                prompt: p.prompt.trim(),
                duration: p.duration
            }));
        } else {
            input.prompt = prompt.trim();
            input.duration = duration;
        }

        // Handle Image URLs mapping
        if (startImageUrl && endImageUrl && !isMultiShot) {
            input.image_urls = [startImageUrl, endImageUrl];
        } else if (startImageUrl) {
            input.image_urls = [startImageUrl];
        } else if (endImageUrl && !isMultiShot) {
            // End image only is usually defined as ["", "end_url"]
            input.image_urls = ["", endImageUrl];
        }

        // Call Kie.ai API
        const response = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${KIE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'kling-3.0/video',
                input,
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

        // Log Generation
        const { error: logError } = await supabase.from('generations').insert({
            user_id: user.id,
            model: 'kling-3.0/video',
            cost: COST,
            duration: totalDuration,
            prediction_id: taskId,
            status: 'processing',
        });

        if (logError) {
            console.error('Error logging generation:', logError);
        }

        return NextResponse.json({
            success: true,
            predictionId: taskId,
            status: 'processing',
            remainingCredits,
            cost: COST
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

// GET endpoint to check video generation status
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
                output: await signStoredMediaUrl(adminSupabase, localGeneration.output_url),
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
                    // Persist video to Supabase Storage
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
                            console.error('Upload to Supabase Storage failed:', uploadError);
                            output = tempUrl;
                        } else {
                            // Store the storage path, not a public URL
                            const storagePath = `generated_videos/${fileName}`;
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
        console.error('Error fetching video status:', error);
        return NextResponse.json({ error: 'Failed to fetch generation status' }, { status: 500 });
    }
}
