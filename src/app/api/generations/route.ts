import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';

export async function GET(request: NextRequest) {
    try {
        const adminSupabase = createServiceClient();
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: { headers: { Authorization: request.headers.get('Authorization')! } },
            }
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json(
                { error: 'Unauthorized' },
                { status: 401 }
            );
        }

        const { data: generations, error } = await supabase
            .from('generations')
            .select('id, output_url, status, created_at, duration, cost, model')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching generations:', error);
            return NextResponse.json(
                { error: 'Failed to fetch generations' },
                { status: 500 }
            );
        }

        // Convert storage paths to signed URLs
        const generationsWithUrls = await Promise.all(
            (generations || []).map(async (gen) => {
                if (!gen.output_url) return gen;
                return {
                    ...gen,
                    output_url: await resolveStoredMediaUrl(adminSupabase, gen.output_url),
                };
            })
        );

        return NextResponse.json({ generations: generationsWithUrls });
    } catch (error) {
        console.error('Error in generations API:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
