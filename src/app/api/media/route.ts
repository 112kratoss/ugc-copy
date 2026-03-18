import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createUserClient, isMediaBucket } from '@/lib/server-helpers';

async function createCookieSupabaseClient() {
    const cookieStore = await cookies();

    return createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll() {
                    // Media requests are read-only; no cookie writes are needed.
                },
            },
        }
    );
}

async function createMediaSupabaseClient(request: NextRequest) {
    if (request.headers.get('Authorization')) {
        return createUserClient(request);
    }

    return createCookieSupabaseClient();
}

export async function GET(request: NextRequest) {
    const bucket = request.nextUrl.searchParams.get('bucket');
    const filePath = request.nextUrl.searchParams.get('path');

    if (!bucket || !isMediaBucket(bucket) || !filePath) {
        return NextResponse.json({ error: 'Invalid media path' }, { status: 400 });
    }

    try {
        const supabase = await createMediaSupabaseClient(request);
        const {
            data: { user },
            error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { data, error } = await supabase.storage.from(bucket).download(filePath);

        if (error || !data) {
            console.error(`Failed to download media ${bucket}/${filePath}:`, error);
            return NextResponse.json({ error: 'Failed to load media' }, { status: 404 });
        }

        const headers = new Headers();
        headers.set(
            'Content-Type',
            data.type || (bucket === 'generated_images' ? 'image/jpeg' : bucket === 'generated_audio' ? 'audio/mpeg' : 'video/mp4')
        );
        headers.set('Content-Length', String(data.size));
        headers.set('Cache-Control', 'private, max-age=60');

        return new NextResponse(data.stream(), {
            status: 200,
            headers,
        });
    } catch (error) {
        console.error('Error serving media:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
