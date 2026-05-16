import { NextRequest, NextResponse } from 'next/server';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import { createUserClient } from '@/lib/server-helpers';
import {
    SHOWCASE_PAGE_SIZE,
    normalizeShowcaseCategory,
    normalizeShowcaseOffset,
    normalizeShowcaseResourceFilter,
    normalizeShowcaseSort,
    normalizeShowcaseUnlockFilter,
    parsePositiveInt,
} from '@/lib/showcase';

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const limit = Math.min(parsePositiveInt(searchParams.get('limit'), SHOWCASE_PAGE_SIZE), 24);
        const tool = searchParams.get('tool');
        let viewerUserId: string | null = null;

        if (request.headers.get('Authorization')) {
            const supabase = createUserClient(request);
            const {
                data: { user },
            } = await supabase.auth.getUser();
            viewerUserId = user?.id ?? null;
        }

        const feed = await getShowcaseFeedPage({
            category: normalizeShowcaseCategory(searchParams.get('category')),
            sort: normalizeShowcaseSort(searchParams.get('sort')),
            offset: normalizeShowcaseOffset(searchParams.get('offset'), searchParams.get('page'), limit),
            limit,
            viewerUserId,
            tool: tool && tool !== 'all' ? tool : null,
            unlock: normalizeShowcaseUnlockFilter(searchParams.get('unlock')),
            resource: normalizeShowcaseResourceFilter(searchParams.get('resource')),
            countryCode: request.headers.get('x-vercel-ip-country'),
        });
        const cacheControl = viewerUserId
            ? 'private, no-store'
            : 'public, s-maxage=60, stale-while-revalidate=300';

        return NextResponse.json(feed, {
            headers: {
                'Cache-Control': cacheControl,
            },
        });
    } catch (error) {
        console.error('Showcase feed error:', error);
        return NextResponse.json({ error: 'Failed to fetch showcase feed' }, { status: 500 });
    }
}
