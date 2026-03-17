import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(request: NextRequest) {
    try {
        // Authenticate request
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            { global: { headers: { Authorization: request.headers.get('Authorization')! } } }
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized: Please log in to remix creations' }, { status: 401 });
        }

        const { generationId } = await request.json();

        if (!generationId) {
            return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
        }

        const { data: generation, error: fetchError } = await supabase
            .from('generations')
            .select('id, category, prompt, workflow_settings')
            .eq('id', generationId)
            .eq('is_public', true)
            .single();

        if (fetchError || !generation) {
            return NextResponse.json({ error: 'Generation is private or not found' }, { status: 404 });
        }

        // 2. Increment the remix count atomically using our RPC function
        const { error: rpcError } = await supabase.rpc('increment_remix_count', {
            p_generation_id: generationId
        });

        if (rpcError) {
            console.error('Error incrementing remix count:', rpcError);
            // We don't necessarily fail the whole request if the counter fails, 
            // the user still wants to remix it. But we should log it.
        }

        // 3. Determine where to redirect the user
        let redirectPath = '/create';
        
        switch (generation.category) {
            case 'image':
                redirectPath = '/create-image';
                break;
            case 'video':
                redirectPath = '/create-video';
                break;
            case 'motion':
                redirectPath = '/create-motion';
                break;
            case 'ugc-ad':
                redirectPath = '/create-video'; // Assuming UGC ads are primarily videos for now
                break;
            default:
                break;
        }

        // Append the remix query parameter so the frontend knows what to fetch/prefill
        // The frontend will actually re-fetch or we can just pass the data directly in the response
        // Passing data directly is faster for the client!

        return NextResponse.json({ 
            success: true, 
            redirectTo: `${redirectPath}?remix=${generationId}`,
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
