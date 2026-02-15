import { NextRequest, NextResponse } from 'next/server';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

export async function POST(request: NextRequest) {
    try {
        const { referenceVideoUrl, characterImageUrl } = await request.json();

        if (!referenceVideoUrl || !characterImageUrl) {
            return NextResponse.json(
                { error: 'Missing referenceVideoUrl or characterImageUrl' },
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

        // Kie.ai API for Kling Motion Control (v2.6)
        // Note: Replacing Replicate logic with direct fetch to Kie.ai
        const response = await fetch('https://api.kie.ai/v1/videos/motion-control', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${KIE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'kling-v2.6',
                image_url: characterImageUrl,
                video_url: referenceVideoUrl,
                duration: 30, // User requested 30s
                guidance_scale: 0.5,
                num_inference_steps: 50
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || data.message || 'Failed to start generation on Kie.ai');
        }

        return NextResponse.json({
            success: true,
            predictionId: data.id, // Kie.ai returns a task/prediction ID
            status: 'processing', // Initial status
        });

    } catch (error: any) {
        console.error('Error starting video generation:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to start video generation' },
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
        const response = await fetch(`https://api.kie.ai/v1/videos/${predictionId}`, {
            headers: {
                'Authorization': `Bearer ${KIE_API_KEY}`,
            },
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || 'Failed to check status');
        }

        // Map Kie.ai status to our app's status
        // Kie might use 'completed' instead of 'succeeded'
        let status = data.status;
        if (status === 'completed') status = 'succeeded';

        const output = data.result?.video_url || data.output || null;

        return NextResponse.json({
            status: status,
            output: output,
            error: data.error,
        });

    } catch (error) {
        console.error('Error fetching prediction:', error);
        return NextResponse.json(
            { error: 'Failed to fetch prediction status' },
            { status: 500 }
        );
    }
}
