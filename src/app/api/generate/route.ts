import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

export async function POST(request: NextRequest) {
    try {
        const { referenceVideoUrl, characterImageUrl, duration = 10, characterOrientation = 'video', mode = '720p', prompt = '' } = await request.json();

        if (!referenceVideoUrl || !characterImageUrl) {
            return NextResponse.json(
                { error: 'Missing referenceVideoUrl or characterImageUrl' },
                { status: 400 }
            );
        }

        // Validate Duration (Basic Sanity Check)
        if (duration <= 0 || duration > 30) {
            return NextResponse.json(
                { error: 'Invalid duration. Must be between 1 and 30 seconds.' },
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

        // Calculate Cost Dynamically
        // 720p: 6 Credits per Second
        // 1080p: 9 Credits per Second
        const creditsPerSecond = mode === '1080p' ? 9 : 6;
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

        // RPC returns -1 if insufficient credits (implementation detail of our RPC)
        if (remainingCredits === -1) {
            return NextResponse.json(
                { error: `Insufficient credits. This generation costs ${COST} credits.` },
                { status: 402 }
            );
        }

        // Kie.ai API for Kling Motion Control (v2.6)
        // Updated to use the new endpoint and payload structure
        const response = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${KIE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'kling-2.6/motion-control',
                input: {
                    prompt: prompt.trim() || "The cartoon character is dancing.",
                    input_urls: [characterImageUrl],
                    video_urls: [referenceVideoUrl],
                    character_orientation: characterOrientation,
                    mode: mode
                }
            })
        });

        const data = await response.json();

        if (!response.ok || data.code !== 200) {
            // Need to refund credits if API call fails
            // For now, logging error. Ideal: call refund_credits RPC.
            console.error('Kie.ai API failed after credit deduction', data);
            throw new Error(data.msg || 'Failed to start generation on Kie.ai');
        }

        const taskId = data.data.taskId;

        // Log Generation
        const { error: logError } = await supabase.from('generations').insert({
            user_id: user.id,
            model: 'kling-2.6/motion-control',
            duration: duration,
            cost: COST,
            prediction_id: taskId,
            status: 'processing'
        });

        if (logError) {
            console.error('Error logging generation:', logError);
            // Non-critical error, proceed
        }

        return NextResponse.json({
            success: true,
            predictionId: taskId, // Kie.ai returns a task ID
            status: 'processing', // Initial status
            remainingCredits: remainingCredits
        });

    } catch (error: unknown) {
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
        // Initialize Supabase client
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: { headers: { Authorization: request.headers.get('Authorization')! } },
            }
        );

        // 1. Check local database first (Cache hit logic)
        const { data: localGeneration } = await supabase
            .from('generations')
            .select('*')
            .eq('prediction_id', predictionId)
            .single();

        if (localGeneration?.status === 'succeeded' && localGeneration?.output_url) {
            return NextResponse.json({
                status: 'succeeded',
                output: localGeneration.output_url,
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

        // Map Kie.ai status to our app's status
        // Kie uses 'waiting', 'success', 'fail'
        let status = data.data.state;
        let output = null;
        let error = null;

        if (status === 'success') {
            status = 'succeeded';
            // resultJson is a stringified JSON
            try {
                const result = JSON.parse(data.data.resultJson);
                const tempUrl = result.resultUrls?.[0] || null;

                if (tempUrl) {
                    // 3. Persist Video -> Download & Upload to Supabase
                    console.log('Generating finished, persisting video...');

                    // Fetch video blob
                    const videoRes = await fetch(tempUrl);
                    if (!videoRes.ok) throw new Error('Failed to download video from Kie');
                    const videoBlob = await videoRes.blob();

                    // Upload to Supabase Storage
                    const fileName = `generated_${predictionId}.mp4`;
                    const { error: uploadError } = await supabase.storage
                        .from('generated_videos')
                        .upload(fileName, videoBlob, {
                            contentType: 'video/mp4',
                            upsert: true
                        });

                    if (uploadError) {
                        console.error('Upload to Supabase failed:', uploadError);
                        // Fallback to temp URL if upload fails, but try to proceed
                        output = tempUrl;
                    } else {
                        // Get Public URL
                        const { data: publicDesc } = supabase.storage
                            .from('generated_videos')
                            .getPublicUrl(fileName);

                        output = publicDesc.publicUrl;

                        // 4. Update Database
                        await supabase
                            .from('generations')
                            .update({
                                status: 'succeeded',
                                output_url: output
                            })
                            .eq('prediction_id', predictionId);
                    }
                }

            } catch (e) {
                console.error('Error persisting video:', e);
                // Return temp URL if persistence fails
                const result = JSON.parse(data.data.resultJson);
                output = result.resultUrls?.[0] || null;
            }
        } else if (status === 'fail') {
            status = 'failed';
            error = data.data.failMsg || 'Unknown error';

            // Update DB on failure too
            await supabase
                .from('generations')
                .update({ status: 'failed' })
                .eq('prediction_id', predictionId);
        }

        return NextResponse.json({
            status: status,
            output: output,
            error: error,
        });

    } catch (error) {
        console.error('Error fetching prediction:', error);
        return NextResponse.json(
            { error: 'Failed to fetch prediction status' },
            { status: 500 }
        );
    }
}
