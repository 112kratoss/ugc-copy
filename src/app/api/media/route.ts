import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createUserClient, isMediaBucket } from '@/lib/server-helpers';

const MEDIA_SIGNED_URL_TTL_SECONDS = 600;

function getDownloadFilename(filePath: string, requestedFilename: string | null): string {
    const fallbackFileName = filePath.split('/').pop() || 'download';
    return (requestedFilename?.trim() || fallbackFileName).replace(/[/\\"]/g, '-');
}

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
    const shouldDownload = request.nextUrl.searchParams.get('download') === '1';
    const requestedFilename = request.nextUrl.searchParams.get('filename');

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

        const signedUrlOptions = shouldDownload
            ? { download: getDownloadFilename(filePath, requestedFilename) }
            : undefined;
        const { data, error } = await supabase.storage
            .from(bucket)
            .createSignedUrl(filePath, MEDIA_SIGNED_URL_TTL_SECONDS, signedUrlOptions);

        if (error || !data?.signedUrl) {
            console.error(`Failed to sign media ${bucket}/${filePath}:`, error);
            return NextResponse.json({ error: 'Failed to load media' }, { status: 404 });
        }

        const response = NextResponse.redirect(data.signedUrl, 302);
        response.headers.set('Cache-Control', 'private, max-age=60');
        return response;
    } catch (error) {
        console.error('Error serving media:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
