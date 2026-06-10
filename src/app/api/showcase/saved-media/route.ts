import { NextRequest, NextResponse } from 'next/server';

import { isMissingPostsSchemaError } from '@/lib/posts-server';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { resolvePostRowsToFeedItems } from '@/lib/showcase-feed';
import {
    parsePositiveInt,
    type ShowcaseFeedItem,
    type ShowcaseFeedPage,
} from '@/lib/showcase';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;

type SavedMediaReference = {
    id: string;
    savedAt: string;
    source: 'post' | 'generation';
};

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

        const searchParams = request.nextUrl.searchParams;
        const limit = Math.min(parsePositiveInt(searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT);
        const offset = parsePositiveInt(searchParams.get('offset'), 0);
        const rangeEnd = offset + limit - 1;

        let savedReferences: SavedMediaReference[] = [];
        let saveSource: SavedMediaReference['source'] = 'post';
        const { data: postSaveData, error: postSaveError } = await supabase
            .from('post_saves')
            .select('post_id, created_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .range(offset, rangeEnd);

        if (postSaveError && !isMissingPostsSchemaError(postSaveError)) {
            console.error('Error fetching post saved media:', postSaveError);
            return NextResponse.json({ error: 'Failed to fetch saved media' }, { status: 500 });
        }

        if (!postSaveError) {
            savedReferences = ((postSaveData ?? []) as Array<{ post_id: string; created_at: string }>)
                .map((row) => ({
                    id: row.post_id,
                    savedAt: row.created_at,
                    source: 'post' as const,
                }));
        }

        if (postSaveError || savedReferences.length === 0) {
            const { data: legacyData, error: legacyError } = await supabase
                .from('showcase_saves')
                .select('generation_id, created_at')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false })
                .range(offset, rangeEnd);

            if (legacyError && postSaveError) {
                console.error('Error fetching legacy showcase saved media:', legacyError);
                return NextResponse.json({ error: 'Failed to fetch saved media' }, { status: 500 });
            }

            if (!legacyError && legacyData?.length) {
                saveSource = 'generation';
                savedReferences = ((legacyData ?? []) as Array<{ generation_id: string; created_at: string }>)
                    .map((row) => ({
                        id: row.generation_id,
                        savedAt: row.created_at,
                        source: 'generation' as const,
                    }));
            }
        }

        if (savedReferences.length === 0) {
            const response: ShowcaseFeedPage = {
                items: [],
                pageInfo: {
                    hasMore: false,
                    nextOffset: null,
                    limit,
                    offset,
                },
            };
            return NextResponse.json(response);
        }

        const savedAtMap = new Map<string, string>();
        for (const reference of savedReferences) {
            if (!savedAtMap.has(reference.id)) {
                savedAtMap.set(reference.id, reference.savedAt);
            }
        }

        const lookupIds = Array.from(savedAtMap.keys());
        const countTable = saveSource === 'post' ? 'post_saves' : 'showcase_saves';
        const countColumn = saveSource === 'post' ? 'post_id' : 'generation_id';

        // Check if there are more results beyond this page.
        const { count: totalSaveCount, error: countError } = await supabase
            .from(countTable)
            .select(countColumn, { count: 'exact', head: true })
            .eq('user_id', user.id);

        let hasMore = offset + savedReferences.length < (totalSaveCount ?? 0);
        if (countError) {
            hasMore = savedReferences.length >= limit;
        }

        // Fetch the matching post rows that are public/unlisted.
        const { data: postRows, error: postError } = await supabase
            .from('posts')
            .select(
                'id, output_url, showcase_asset_path, prompt, title, body, category, post_format, save_count, remix_count, created_at, user_id, source_kind, source_tool, source_tool_slug, review_status, generation_id, visibility'
            )
            .in(saveSource === 'post' ? 'id' : 'generation_id', lookupIds)
            .in('visibility', ['public', 'unlisted']);

        if (postError) {
            console.error('Error fetching saved post rows:', postError);
            return NextResponse.json({ error: 'Failed to fetch saved media' }, { status: 500 });
        }

        // Hydrate posts into feed items.
        const adminSupabase = createServiceClient();
        const hydratedItems = await resolvePostRowsToFeedItems(
            (postRows ?? []) as Parameters<typeof resolvePostRowsToFeedItems>[0],
            adminSupabase
        );

        // Attach savedAt and preserve save-row order.
        const hydratedMap = new Map<string, ShowcaseFeedItem>();
        for (const item of hydratedItems) {
            hydratedMap.set(saveSource === 'post' ? item.id : (item.generationId ?? item.id), item);
        }

        const orderedItems: ShowcaseFeedItem[] = [];
        for (const lookupId of lookupIds) {
            const item = hydratedMap.get(lookupId);
            if (item) {
                orderedItems.push({
                    ...item,
                    isSaved: true,
                    savedAt: savedAtMap.get(lookupId),
                });
            }
        }

        const response: ShowcaseFeedPage = {
            items: orderedItems,
            pageInfo: {
                hasMore,
                nextOffset: hasMore ? offset + limit : null,
                limit,
                offset,
            },
        };

        return NextResponse.json(response, {
            headers: {
                'Cache-Control': 'private, no-store',
            },
        });
    } catch (error) {
        console.error('Saved media feed error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
