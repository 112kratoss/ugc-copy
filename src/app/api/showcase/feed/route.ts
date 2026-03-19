import { NextRequest, NextResponse } from 'next/server';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import {
    SHOWCASE_PAGE_SIZE,
    normalizeShowcaseCategory,
    normalizeShowcaseOffset,
    normalizeShowcaseSort,
    parsePositiveInt,
} from '@/lib/showcase';

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const limit = Math.min(parsePositiveInt(searchParams.get('limit'), SHOWCASE_PAGE_SIZE), 24);

        const feed = await getShowcaseFeedPage({
            category: normalizeShowcaseCategory(searchParams.get('category')),
            sort: normalizeShowcaseSort(searchParams.get('sort')),
            offset: normalizeShowcaseOffset(searchParams.get('offset'), searchParams.get('page'), limit),
            limit,
        });

        return NextResponse.json(feed, {
            headers: {
                'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
            },
        });
    } catch (error) {
        console.error('Showcase feed error:', error);
        return NextResponse.json({ error: 'Failed to fetch showcase feed' }, { status: 500 });
    }
}
