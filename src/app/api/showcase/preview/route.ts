import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, createUserClient, getStoredMediaLocation } from '@/lib/server-helpers';

/**
 * GET /api/showcase/preview?id=<generationId>
 *
 * Returns a signed URL for the original media of a public generation.
 * Uses the service-role key so that any authenticated user can preview
 * another user's public creation (bypasses storage RLS).
 */
export async function GET(request: NextRequest) {
    const generationId = request.nextUrl.searchParams.get('id');

    if (!generationId) {
        return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
    }

    // 1. Authenticate the caller (any logged-in user is fine)
    const userSupabase = createUserClient(request);
    const { data: { user }, error: authError } = await userSupabase.auth.getUser();

    if (authError || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Use the service client to fetch the generation (no RLS restrictions)
    const serviceSupabase = createServiceClient();

    const { data: generation, error: fetchError } = await serviceSupabase
        .from('generations')
        .select('output_url, is_public')
        .eq('id', generationId)
        .single();

    if (fetchError || !generation) {
        return NextResponse.json({ error: 'Generation not found' }, { status: 404 });
    }

    if (!generation.is_public) {
        return NextResponse.json({ error: 'Generation is private' }, { status: 403 });
    }

    if (!generation.output_url) {
        return NextResponse.json({ error: 'No media available' }, { status: 404 });
    }

    // 3. If already an HTTP URL, return as-is
    if (generation.output_url.startsWith('http')) {
        return NextResponse.json({ url: generation.output_url });
    }

    // 4. Resolve the storage path and create a signed URL with the service key
    const location = getStoredMediaLocation(generation.output_url);

    if (!location) {
        return NextResponse.json({ error: 'Invalid media path' }, { status: 400 });
    }

    const { data: signedData, error: signError } = await serviceSupabase.storage
        .from(location.bucket)
        .createSignedUrl(location.filePath, 3600);

    if (signError || !signedData?.signedUrl) {
        console.error('Failed to sign preview URL:', signError);
        return NextResponse.json({ error: 'Failed to generate preview URL' }, { status: 500 });
    }

    return NextResponse.json({ url: signedData.signedUrl });
}
