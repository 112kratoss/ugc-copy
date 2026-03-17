import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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

        const { generationId } = await request.json();

        if (!generationId) {
            return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
        }

        // We use the service role client exclusively for the RPC call
        const adminSupabase = createServiceClient();

        // Call our custom Postgres function to handle the upsert/delete and increment/decrement atomically
        const { data: isSaved, error: rpcError } = await adminSupabase.rpc('toggle_showcase_save', {
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
