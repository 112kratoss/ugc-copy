import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { syncGenerationStatuses } from '@/lib/generation-services';
import { buildMediaProxyUrl, getStoredMediaLocation } from '@/lib/server-helpers';

type LinkedPostRow = {
    id: string;
    generation_id: string | null;
    title: string | null;
    visibility: 'public' | 'unlisted' | 'private';
    archived_at: string | null;
};

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

        const includeArchived = request.nextUrl.searchParams.get('includeArchived') === 'true';

        const fetchGenerations = async () => {
            let query = supabase
                .from('generations')
                .select('id, output_url, showcase_asset_path, status, created_at, completed_at, duration, cost, model, category, is_public, title, description, prompt, archived_at')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (!includeArchived) {
                query = query.is('archived_at', null);
            }

            const result = await query;

            if (result.error) {
                throw result.error;
            }

            return result.data || [];
        };

        let generations = await fetchGenerations();
        const processingGenerationIds = generations
            .filter((generation) => generation.status === 'processing' || generation.status === 'waiting')
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

        const generationIds = generations.map((generation) => generation.id).filter(Boolean);
        const linkedPostMap = new Map<string, LinkedPostRow>();

        if (generationIds.length > 0) {
            let postsQuery = supabase
                .from('posts')
                .select('id, generation_id, title, visibility, archived_at')
                .in('generation_id', generationIds)
                .eq('user_id', user.id);

            if (!includeArchived) {
                postsQuery = postsQuery.is('archived_at', null);
            }

            const postsResult = await postsQuery;
            if (postsResult.error) {
                console.error('Failed to load linked posts for generations:', postsResult.error);
            } else {
                for (const post of (postsResult.data ?? []) as LinkedPostRow[]) {
                    if (post.generation_id) {
                        linkedPostMap.set(post.generation_id, post);
                    }
                }
            }
        }

        const generationsWithUrls = generations.map((generation) => {
            if (!generation.output_url) {
                return {
                    ...generation,
                    linked_post_id: linkedPostMap.get(generation.id)?.id ?? null,
                    linked_post_title: linkedPostMap.get(generation.id)?.title ?? null,
                    linked_post_visibility: linkedPostMap.get(generation.id)?.visibility ?? null,
                    linked_post_archived_at: linkedPostMap.get(generation.id)?.archived_at ?? null,
                };
            }

            const storedLocation = getStoredMediaLocation(generation.output_url);
            if (!storedLocation) {
                return {
                    ...generation,
                    linked_post_id: linkedPostMap.get(generation.id)?.id ?? null,
                    linked_post_title: linkedPostMap.get(generation.id)?.title ?? null,
                    linked_post_visibility: linkedPostMap.get(generation.id)?.visibility ?? null,
                    linked_post_archived_at: linkedPostMap.get(generation.id)?.archived_at ?? null,
                };
            }

            return {
                ...generation,
                output_url: buildMediaProxyUrl(storedLocation.bucket, storedLocation.filePath),
                linked_post_id: linkedPostMap.get(generation.id)?.id ?? null,
                linked_post_title: linkedPostMap.get(generation.id)?.title ?? null,
                linked_post_visibility: linkedPostMap.get(generation.id)?.visibility ?? null,
                linked_post_archived_at: linkedPostMap.get(generation.id)?.archived_at ?? null,
            };
        });

        return NextResponse.json({ generations: generationsWithUrls });
    } catch (error) {
        console.error('Error fetching generations:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
