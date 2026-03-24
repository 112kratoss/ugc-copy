import 'server-only';

import { unstable_cache } from 'next/cache';

import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import {
    type ShowcaseCategory,
    type ShowcaseFeedItem,
    type ShowcaseFeedPage,
    type ShowcaseItemCategory,
    type ShowcaseSort,
} from '@/lib/showcase';

interface ProfileSummary {
    id: string;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
}

interface GenerationRow {
    id: string;
    output_url: string | null;
    showcase_asset_path: string | null;
    model: string;
    prompt: string | null;
    title: string | null;
    category: ShowcaseItemCategory | null;
    save_count: number | null;
    remix_count: number | null;
    created_at: string;
    user_id: string | null;
}

function resolveItemCategory(category: ShowcaseItemCategory | null): ShowcaseItemCategory {
    if (category === 'video' || category === 'motion' || category === 'ugc-ad') {
        return category;
    }

    return 'image';
}

function resolvePublicShowcaseUrl(
    adminSupabase: ReturnType<typeof createServiceClient>,
    showcaseAssetPath: string
): string {
    const { data } = adminSupabase.storage.from('showcase_media').getPublicUrl(showcaseAssetPath);
    return data.publicUrl;
}

async function resolveFeedItemUrl(
    adminSupabase: ReturnType<typeof createServiceClient>,
    generation: GenerationRow
): Promise<string | null> {
    if (generation.showcase_asset_path) {
        return resolvePublicShowcaseUrl(adminSupabase, generation.showcase_asset_path);
    }

    if (!generation.output_url) {
        return null;
    }

    if (generation.output_url.startsWith('http')) {
        return generation.output_url;
    }

    return resolveStoredMediaUrl(adminSupabase, generation.output_url);
}

async function getShowcaseFeedPageBase(
    category: ShowcaseCategory,
    sort: ShowcaseSort,
    offset: number,
    limit: number
): Promise<ShowcaseFeedPage> {
    const adminSupabase = createServiceClient();

    const buildQuery = async (includeShowcaseAssetPath: boolean) => {
        if (includeShowcaseAssetPath) {
            let query = adminSupabase
                .from('generations')
                .select('id, output_url, showcase_asset_path, model, prompt, title, category, save_count, remix_count, created_at, user_id')
                .eq('is_public', true)
                .eq('status', 'succeeded')
                .not('output_url', 'is', null);

            if (category !== 'all') {
                query = query.eq('category', category);
            }

            if (sort === 'top-saves') {
                query = query
                    .order('save_count', { ascending: false })
                    .order('created_at', { ascending: false })
                    .order('id', { ascending: false });
            } else if (sort === 'top-remixes') {
                query = query
                    .order('remix_count', { ascending: false })
                    .order('created_at', { ascending: false })
                    .order('id', { ascending: false });
            } else {
                query = query
                    .order('created_at', { ascending: false })
                    .order('id', { ascending: false });
            }

            const result = await query.range(offset, offset + limit);
            return {
                data: result.data as GenerationRow[] | null,
                error: result.error,
            };
        }

        let query = adminSupabase
            .from('generations')
            .select('id, output_url, model, prompt, title, category, save_count, remix_count, created_at, user_id')
            .eq('is_public', true)
            .eq('status', 'succeeded')
            .not('output_url', 'is', null);

        if (category !== 'all') {
            query = query.eq('category', category);
        }

        if (sort === 'top-saves') {
            query = query
                .order('save_count', { ascending: false })
                .order('created_at', { ascending: false })
                .order('id', { ascending: false });
        } else if (sort === 'top-remixes') {
            query = query
                .order('remix_count', { ascending: false })
                .order('created_at', { ascending: false })
                .order('id', { ascending: false });
        } else {
            query = query
                .order('created_at', { ascending: false })
                .order('id', { ascending: false });
        }

        const result = await query.range(offset, offset + limit);
        return {
            data: result.data?.map((generation) => ({
                ...generation,
                showcase_asset_path: null,
            })) as GenerationRow[] | null,
            error: result.error,
        };
    };

    let { data: generations, error } = await buildQuery(true);

    if (error?.code === '42703') {
        const fallbackResult = await buildQuery(false);
        generations = fallbackResult.data;
        error = fallbackResult.error;
    }

    if (error) {
        console.error('Error fetching showcase feed:', error);
        throw error;
    }

    const pageRows = (generations ?? []) as GenerationRow[];
    const hasMore = pageRows.length > limit;
    const visibleRows = hasMore ? pageRows.slice(0, limit) : pageRows;
    const userIds = Array.from(new Set(visibleRows.map((row) => row.user_id).filter(Boolean))) as string[];

    const profilesMap: Record<string, ProfileSummary> = {};
    if (userIds.length > 0) {
        const { data: profiles, error: profilesError } = await adminSupabase
            .from('profiles')
            .select('id, username, display_name, avatar_url')
            .in('id', userIds);

        if (profilesError) {
            console.error('Error fetching showcase creator profiles:', profilesError);
        } else {
            for (const profile of profiles ?? []) {
                profilesMap[profile.id] = profile;
            }
        }
    }

    const resolvedItems = await Promise.all(
        visibleRows.map(async (generation): Promise<ShowcaseFeedItem | null> => {
            const url = await resolveFeedItemUrl(adminSupabase, generation);
            if (!url) {
                return null;
            }

            const profile = generation.user_id ? profilesMap[generation.user_id] : undefined;

            return {
                id: generation.id,
                url,
                model: generation.model,
                title: generation.title || 'Untitled Creation',
                prompt: generation.prompt || '',
                category: resolveItemCategory(generation.category),
                saveCount: generation.save_count || 0,
                remixCount: generation.remix_count || 0,
                createdAt: generation.created_at,
                creator: {
                    id: profile?.id ?? null,
                    username: profile?.username ?? null,
                    name: profile?.display_name || profile?.username || 'Anonymous',
                    avatar: profile?.avatar_url ?? null,
                },
            };
        })
    );

    const items = resolvedItems.filter((item): item is ShowcaseFeedItem => item !== null);

    return {
        items,
        pageInfo: {
            hasMore,
            nextOffset: hasMore ? offset + limit : null,
            limit,
            offset,
        },
    };
}

const getCachedShowcaseFeedPageBase = unstable_cache(
    getShowcaseFeedPageBase,
    ['showcase-feed-base'],
    { revalidate: 60 }
);

function isMissingIncrementalCacheError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('incrementalCache missing');
}

async function loadShowcaseFeedPageBase(
    category: ShowcaseCategory,
    sort: ShowcaseSort,
    offset: number,
    limit: number
): Promise<ShowcaseFeedPage> {
    try {
        return await getCachedShowcaseFeedPageBase(category, sort, offset, limit);
    } catch (error) {
        if (isMissingIncrementalCacheError(error)) {
            return getShowcaseFeedPageBase(category, sort, offset, limit);
        }

        throw error;
    }
}

export async function getShowcaseFeedPage(options: {
    category: ShowcaseCategory;
    sort: ShowcaseSort;
    offset: number;
    limit: number;
    viewerUserId?: string | null;
}): Promise<ShowcaseFeedPage> {
    const { category, sort, offset, limit } = options;
    const adminSupabase = createServiceClient();
    const viewerUserId = options.viewerUserId ?? null;
    const baseFeed = await loadShowcaseFeedPageBase(category, sort, offset, limit);

    if (!viewerUserId || baseFeed.items.length === 0) {
        return baseFeed;
    }

    const { data: savedItems, error } = await adminSupabase
        .from('showcase_saves')
        .select('generation_id')
        .eq('user_id', viewerUserId)
        .in('generation_id', baseFeed.items.map((item) => item.id));

    if (error) {
        console.error('Error fetching showcase saved state for feed page:', error);
        return baseFeed;
    }

    const savedIdSet = new Set((savedItems ?? []).map((row) => row.generation_id));

    return {
        ...baseFeed,
        items: baseFeed.items.map((item) => ({
            ...item,
            isSaved: savedIdSet.has(item.id),
        })),
    };
}
