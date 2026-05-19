import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import {
    findPublicPostReferenceByIdOrGenerationId,
    isMissingPostsSchemaError,
} from '@/lib/posts-server';
import { notifyPostSocialActivity } from '@/lib/mobile-notifications';
import { createServiceClient } from '@/lib/server-helpers';

export async function POST(request: NextRequest) {
    try {
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            { global: { headers: { Authorization: request.headers.get('Authorization')! } } }
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { generationId, postId } = await request.json();
        const referenceId = typeof postId === 'string' ? postId : generationId;

        if (!referenceId || typeof referenceId !== 'string') {
            return NextResponse.json({ error: 'Missing post ID' }, { status: 400 });
        }

        const post = await findPublicPostReferenceByIdOrGenerationId(referenceId);
        if (!post) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        let isSaved: boolean | null = null;
        let rpcError: unknown = null;

        const postSaveResult = await supabase.rpc('toggle_post_save', {
            p_post_id: post.id,
            p_user_id: user.id
        });

        isSaved = postSaveResult.data;
        rpcError = postSaveResult.error;

        if (rpcError && isMissingPostsSchemaError(rpcError)) {
            const legacySaveResult = await supabase.rpc('toggle_showcase_save', {
                p_generation_id: post.generation_id ?? post.id,
                p_user_id: user.id
            });

            isSaved = legacySaveResult.data;
            rpcError = legacySaveResult.error;
        }

        if (rpcError) {
            console.error('Error toggling save:', rpcError);
            return NextResponse.json({ error: 'Failed to update save status' }, { status: 500 });
        }

        if (isSaved) {
            await notifyPostSocialActivity(createServiceClient(), {
                type: 'post_saved',
                recipientUserId: post.user_id,
                actorUserId: user.id,
                postId: post.id,
            });
        }

        return NextResponse.json({ 
            success: true, 
            isSaved,
            message: isSaved ? 'Saved to bookmarks' : 'Removed from bookmarks'
        });

    } catch (error) {
        console.error('Save error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
