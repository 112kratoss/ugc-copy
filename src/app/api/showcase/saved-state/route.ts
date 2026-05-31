import { NextRequest, NextResponse } from 'next/server';

import { isMissingPostsSchemaError } from '@/lib/posts-server';
import { createUserClient } from '@/lib/server-helpers';

export async function GET(request: NextRequest) {
    try {
        const supabase = createUserClient(request);
        const {
            data: { user },
            error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const idsParam = request.nextUrl.searchParams.get('ids');
        const ids = (idsParam ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
            .slice(0, 100);

        if (ids.length === 0) {
            return NextResponse.json([]);
        }

        const { data: postSaveRows, error: postSaveError } = await supabase
            .from('post_saves')
            .select('post_id')
            .eq('user_id', user.id)
            .in('post_id', ids);

        if (postSaveError && isMissingPostsSchemaError(postSaveError)) {
            const { data: legacyRows, error: legacyError } = await supabase
                .from('showcase_saves')
                .select('generation_id')
                .eq('user_id', user.id)
                .in('generation_id', ids);

            if (legacyError) {
                console.error('Error fetching legacy showcase saved state:', legacyError);
                return NextResponse.json({ error: 'Failed to fetch saved state' }, { status: 500 });
            }

            return NextResponse.json((legacyRows ?? []).map((row) => row.generation_id));
        }

        if (postSaveError) {
            console.error('Error fetching post saved state:', postSaveError);
            return NextResponse.json({ error: 'Failed to fetch saved state' }, { status: 500 });
        }

        return NextResponse.json((postSaveRows ?? []).map((row) => row.post_id));
    } catch (error) {
        console.error('Showcase saved-state error:', error);
        return NextResponse.json({ error: 'Failed to fetch saved state' }, { status: 500 });
    }
}
