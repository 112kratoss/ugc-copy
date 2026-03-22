import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { syncGenerationStatuses } from '@/lib/generation-services';
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

        const fetchGenerations = async () => {
            const result = await supabase
                .from('generations')
                .select('id, output_url, status, created_at, duration, cost, model, category, is_public')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (result.error) {
                throw result.error;
            }

            return result.data || [];
        };

        let generations = await fetchGenerations();
        const processingGenerationIds = generations
            .filter((generation) => generation.status === 'processing')
            .map((generation) => generation.id);

        if (processingGenerationIds.length > 0) {
            try {
                await syncGenerationStatuses({
                    supabase,
                    generationIds: processingGenerationIds,
                });
                generations = await fetchGenerations();
            } catch (syncError) {
                console.error('Failed to sync generation statuses before listing creations:', syncError);
            }
        }

        const generationsWithUrls = generations.map((generation) => {
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
        console.error('Error fetching generations:', error);
        console.error('Error in generations API:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
