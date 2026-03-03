import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Supported URL patterns
const SUPPORTED_PATTERNS = [
    { regex: /instagram\.com\/(p|reel|reels|tv)\//i, name: 'Instagram' },
    { regex: /tiktok\.com\//i, name: 'TikTok' },
    { regex: /youtube\.com\/shorts\//i, name: 'YouTube Shorts' },
    { regex: /youtu\.be\//i, name: 'YouTube' },
    { regex: /youtube\.com\/watch/i, name: 'YouTube' },
];

function getSupportedPlatform(url: string): string | null {
    for (const pattern of SUPPORTED_PATTERNS) {
        if (pattern.regex.test(url)) return pattern.name;
    }
    return null;
}

/**
 * Scrape the video URL from a social media page by extracting og:video meta tags.
 * This is a free approach that works for public content.
 */
async function scrapeVideoUrl(url: string): Promise<string | null> {
    // Fetch the page HTML with browser-like headers to avoid bot detection
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
        },
        redirect: 'follow',
    });

    if (!response.ok) {
        console.error(`Failed to fetch page: HTTP ${response.status}`);
        return null;
    }

    const html = await response.text();

    // Try multiple meta tag patterns to extract the video URL
    const patterns = [
        // og:video (most common for Instagram, TikTok)
        /<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i,
        /<meta\s+content=["']([^"']+)["']\s+property=["']og:video["']/i,
        // og:video:url
        /<meta\s+property=["']og:video:url["']\s+content=["']([^"']+)["']/i,
        /<meta\s+content=["']([^"']+)["']\s+property=["']og:video:url["']/i,
        // og:video:secure_url
        /<meta\s+property=["']og:video:secure_url["']\s+content=["']([^"']+)["']/i,
        /<meta\s+content=["']([^"']+)["']\s+property=["']og:video:secure_url["']/i,
        // Direct video URL in JSON-LD structured data
        /"video_url"\s*:\s*"([^"]+)"/i,
        /"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)/i,
        // TikTok-specific patterns
        /"playAddr"\s*:\s*"([^"]+)"/i,
        /"downloadAddr"\s*:\s*"([^"]+)"/i,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
            // Decode HTML entities in the URL
            const videoUrl = match[1]
                .replace(/&amp;/g, '&')
                .replace(/\\u0026/g, '&')
                .replace(/\\\//g, '/');
            console.log('Found video URL via pattern:', pattern.source);
            return videoUrl;
        }
    }

    console.log('No video URL found in page HTML (length:', html.length, ')');
    return null;
}

export async function POST(request: NextRequest) {
    try {
        const { url } = await request.json();

        if (!url || typeof url !== 'string') {
            return NextResponse.json({ error: 'Missing or invalid URL' }, { status: 400 });
        }

        const platform = getSupportedPlatform(url);
        if (!platform) {
            return NextResponse.json(
                { error: 'Unsupported URL. Please paste an Instagram, TikTok, or YouTube link.' },
                { status: 400 }
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

        // Step 1: Scrape the video URL from the page
        console.log(`Resolving ${platform} URL:`, url);
        const directVideoUrl = await scrapeVideoUrl(url);

        if (!directVideoUrl) {
            return NextResponse.json(
                { error: `Could not extract video from this ${platform} link. Make sure the post is public and contains a video.` },
                { status: 422 }
            );
        }

        // Step 2: Download the video
        console.log('Downloading video from:', directVideoUrl.substring(0, 100) + '...');
        const videoResponse = await fetch(directVideoUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': url,
            },
        });

        if (!videoResponse.ok) {
            console.error('Video download failed:', videoResponse.status, videoResponse.statusText);
            return NextResponse.json(
                { error: 'Failed to download video. The link may be private or expired.' },
                { status: 502 }
            );
        }

        const videoBlob = await videoResponse.blob();

        // Check file size (100MB limit)
        if (videoBlob.size > 100 * 1024 * 1024) {
            return NextResponse.json({ error: 'Video file too large (max 100MB).' }, { status: 413 });
        }

        if (videoBlob.size < 10000) {
            // Likely got an HTML page or error instead of a video
            return NextResponse.json(
                { error: `Could not download the video from ${platform}. The post may be private.` },
                { status: 422 }
            );
        }

        // Step 3: Upload to Supabase Storage
        const fileName = `imported_${Date.now()}_${Math.random().toString(36).substring(2)}.mp4`;
        console.log('Uploading to Supabase storage:', fileName, '| Size:', Math.round(videoBlob.size / 1024), 'KB');

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
            platform,
        });

    } catch (error) {
        console.error('Error resolving video URL:', error);
        return NextResponse.json(
            { error: 'Something went wrong while importing the video.' },
            { status: 500 }
        );
    }
}
