import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { notifyPostSocialActivity } from '@/lib/mobile-notifications';
import { findPublicPostReferenceByIdOrGenerationId } from '@/lib/posts-server';
import { createServiceClient } from '@/lib/server-helpers';

function getRedirectPathForCategory(category: string | null | undefined): string {
    switch (category) {
        case 'image':
            return '/create-image';
        case 'video':
        case 'ugc-ad':
            return '/create-video';
        case 'motion':
            return '/create-motion';
        default:
            return '/create';
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            { global: { headers: { Authorization: request.headers.get('Authorization')! } } }
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized: Please log in to remix creations' }, { status: 401 });
        }

        const { generationId, postId } = await request.json();
        const referenceId = typeof postId === 'string' ? postId : generationId;

        if (!referenceId || typeof referenceId !== 'string') {
            return NextResponse.json({ error: 'Missing post ID' }, { status: 400 });
        }

        const post = await findPublicPostReferenceByIdOrGenerationId(referenceId);
        if (!post) {
            return NextResponse.json({ error: 'Creation is private or not found' }, { status: 404 });
        }

        const redirectPath = getRedirectPathForCategory(post.category);

        if (!post.generation_id) {
            return NextResponse.json({ error: 'Only generation-backed posts can be remixed' }, { status: 400 });
        }

        const { error: rpcError } = await supabase.rpc('increment_post_remix_count', {
            p_post_id: post.id
        });

        if (rpcError) {
            console.error('Error incrementing remix count:', rpcError);
        }

        const { data: generation, error: generationError } = await supabase
            .from('generations')
            .select('id, prompt, workflow_settings')
            .eq('id', post.generation_id)
            .single();

        if (generationError || !generation) {
            return NextResponse.json({ error: 'Linked generation not found' }, { status: 404 });
        }

        await notifyPostSocialActivity(createServiceClient(), {
            type: 'post_remixed',
            recipientUserId: post.user_id,
            actorUserId: user.id,
            postId: post.id,
        });

        return NextResponse.json({ 
            success: true, 
            redirectTo: `${redirectPath}?remix=${generation.id}`,
            prefill: {
                prompt: generation.prompt || '',
                settings: generation.workflow_settings || {}
            }
        });

    } catch (error) {
        console.error('Remix error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
