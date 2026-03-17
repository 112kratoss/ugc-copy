import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

        const { generationId } = await request.json();

        if (!generationId) {
            return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
        }

        const { data: generation, error: fetchError } = await supabase
            .from('generations')
            .select('id, is_public')
            .eq('id', generationId)
            .single();

        if (fetchError || !generation) {
            return NextResponse.json({ error: 'Generation not found' }, { status: 404 });
        }

        if (!generation.is_public) {
            return NextResponse.json({ error: 'Only public showcase items can be saved' }, { status: 400 });
        }

        // Toggle save atomically using the authenticated user's context.
        const { data: isSaved, error: rpcError } = await supabase.rpc('toggle_showcase_save', {
            p_generation_id: generationId,
            p_user_id: user.id
        });

        if (rpcError) {
            console.error('Error toggling save:', rpcError);
            // Example errors might be foreign key violations if generation_id is bogus
            return NextResponse.json({ error: 'Failed to update save status' }, { status: 500 });
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
