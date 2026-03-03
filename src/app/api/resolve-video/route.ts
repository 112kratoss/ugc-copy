import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'social-media-video-downloader.p.rapidapi.com';

// Supported URL patterns
const SUPPORTED_PATTERNS = [
    /instagram\.com\/(p|reel|reels|tv)\//i,
    /tiktok\.com\//i,
    /youtube\.com\/shorts\//i,
    /youtu\.be\//i,
    /youtube\.com\/watch/i,
];

function isSupportedUrl(url: string): boolean {
    return SUPPORTED_PATTERNS.some(pattern => pattern.test(url));
}

export async function POST(request: NextRequest) {
    try {
        const { url } = await request.json();

        if (!url || typeof url !== 'string') {
            return NextResponse.json({ error: 'Missing or invalid URL' }, { status: 400 });
        }

        if (!isSupportedUrl(url)) {
            return NextResponse.json(
                { error: 'Unsupported URL. Please paste an Instagram, TikTok, or YouTube link.' },
                { status: 400 }
            );
        }

        if (!RAPIDAPI_KEY) {
            console.error('RAPIDAPI_KEY not configured');
            return NextResponse.json(
                { error: 'Server configuration error: Video download service not configured' },
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

        // Verify user is authenticated
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Step 1: Resolve the social media URL to a direct video link via RapidAPI
        console.log('Resolving social media URL:', url);
        const apiResponse = await fetch(`https://${RAPIDAPI_HOST}/smvd/get/all?url=${encodeURIComponent(url)}`, {
            method: 'GET',
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST,
            },
        });

        const apiData = await apiResponse.json();

        if (!apiResponse.ok || !apiData.success) {
            console.error('RapidAPI resolve failed:', apiData);
            return NextResponse.json(
                { error: 'Failed to resolve video from the provided link. Make sure the post is public.' },
                { status: 422 }
            );
        }

        // Extract the best quality video URL from the response
        // The API typically returns links array with quality options
        let directVideoUrl: string | null = null;

        if (apiData.links && Array.isArray(apiData.links)) {
            // Prefer HD/high quality mp4
            const hdLink = apiData.links.find(
                (l: { quality: string; link: string }) => l.quality?.toLowerCase().includes('hd') || l.quality?.toLowerCase().includes('720')
            );
            const anyLink = apiData.links.find(
                (l: { link: string }) => l.link?.endsWith('.mp4') || l.link?.includes('video')
            );
            directVideoUrl = hdLink?.link || anyLink?.link || apiData.links[0]?.link;
        }

        if (!directVideoUrl) {
            console.error('No video URL found in API response:', apiData);
            return NextResponse.json(
                { error: 'Could not extract video from this link. It may not contain a video or may be private.' },
                { status: 422 }
            );
        }

        // Step 2: Download the video binary
        console.log('Downloading video from resolved URL...');
        const videoResponse = await fetch(directVideoUrl);
        if (!videoResponse.ok) {
            return NextResponse.json(
                { error: 'Failed to download the video. The link may have expired.' },
                { status: 502 }
            );
        }

        const videoBlob = await videoResponse.blob();

        // Check file size (100MB limit)
        if (videoBlob.size > 100 * 1024 * 1024) {
            return NextResponse.json(
                { error: 'Video file too large (max 100MB).' },
                { status: 413 }
            );
        }

        // Step 3: Upload to Supabase Storage
        const fileName = `imported_${Date.now()}_${Math.random().toString(36).substring(2)}.mp4`;
        console.log('Uploading to Supabase storage:', fileName);

        const { error: uploadError } = await supabase.storage
            .from('uploads')
            .upload(fileName, videoBlob, {
                contentType: 'video/mp4',
                upsert: false,
            });

        if (uploadError) {
            console.error('Supabase upload failed:', uploadError);
            return NextResponse.json(
                { error: 'Failed to save video. Please try again.' },
                { status: 500 }
            );
        }

        // Step 4: Get public URL
        const { data: publicData } = supabase.storage
            .from('uploads')
            .getPublicUrl(fileName);

        console.log('Video imported successfully:', publicData.publicUrl);

        return NextResponse.json({
            success: true,
            videoUrl: publicData.publicUrl,
        });

    } catch (error) {
        console.error('Error resolving video URL:', error);
        return NextResponse.json(
            { error: 'Something went wrong while importing the video.' },
            { status: 500 }
        );
    }
}
