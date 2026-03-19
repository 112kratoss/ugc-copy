import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { buildMediaProxyUrl, getStoredMediaLocation } from '@/lib/server-helpers';

export async function GET(request: NextRequest) {
    try {
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
            .select('id, output_url, status, created_at, duration, cost, model, category, is_public')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching generations:', error);
            return NextResponse.json(
                { error: 'Failed to fetch generations' },
                { status: 500 }
            );
        }

        const generationsWithUrls = (generations || []).map((generation) => {
            if (!generation.output_url) {
                return generation;
            }

            const storedLocation = getStoredMediaLocation(generation.output_url);
            if (!storedLocation) {
                return generation;
            }

            return {
                ...generation,
                output_url: buildMediaProxyUrl(storedLocation.bucket, storedLocation.filePath),
            };
        });

        return NextResponse.json({ generations: generationsWithUrls });
    } catch (error) {
        console.error('Error in generations API:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
