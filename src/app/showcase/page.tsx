import type { Metadata } from 'next';

import ShowcaseClient from '@/app/showcase/ShowcaseClient';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import {
    SHOWCASE_PAGE_SIZE,
    normalizeShowcaseCategory,
    normalizeShowcaseOffset,
    normalizeShowcaseSort,
} from '@/lib/showcase';
import { createMetadata } from '@/lib/seo';

type ShowcasePageProps = {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const SHOWCASE_PARAM_KEYS = new Set(['category', 'sort', 'offset', 'page']);

function getFirstValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ searchParams }: ShowcasePageProps): Promise<Metadata> {
    const resolvedSearchParams = searchParams ? await searchParams : {};
    const rawCategory = getFirstValue(resolvedSearchParams.category);
    const rawSort = getFirstValue(resolvedSearchParams.sort);
    const rawOffset = getFirstValue(resolvedSearchParams.offset);
    const rawPage = getFirstValue(resolvedSearchParams.page);

    const category = normalizeShowcaseCategory(rawCategory);
    const sort = normalizeShowcaseSort(rawSort);
    const offset = normalizeShowcaseOffset(rawOffset, rawPage, SHOWCASE_PAGE_SIZE);
    const hasUnknownQuery = Object.keys(resolvedSearchParams).some((key) => !SHOWCASE_PARAM_KEYS.has(key));
    const hasNonDefaultVariant =
        hasUnknownQuery ||
        (typeof rawCategory === 'string' && category !== 'all') ||
        (typeof rawSort === 'string' && sort !== 'recent') ||
        offset > 0;

    return createMetadata({
        title: 'Showcase',
        description:
            'Browse public UGC copy creations, saved community work, and production-ready examples of AI images, videos, and motion-transfer ads.',
        path: '/showcase',
        keywords: ['AI showcase', 'UGC ad examples', 'AI image examples', 'AI video examples'],
        noIndex: hasNonDefaultVariant,
    });
}

export default async function ShowcasePage({ searchParams }: ShowcasePageProps) {
    const resolvedSearchParams = searchParams ? await searchParams : {};
    const category = normalizeShowcaseCategory(getFirstValue(resolvedSearchParams.category));
    const sort = normalizeShowcaseSort(getFirstValue(resolvedSearchParams.sort));
    const offset = normalizeShowcaseOffset(
        getFirstValue(resolvedSearchParams.offset),
        getFirstValue(resolvedSearchParams.page),
        SHOWCASE_PAGE_SIZE
    );

    const initialFeed = await getShowcaseFeedPage({
        category,
        sort,
        offset,
        limit: SHOWCASE_PAGE_SIZE,
    });

    return (
        <ShowcaseClient
            initialFeed={initialFeed}
            initialCategory={category}
            initialSort={sort}
        />
    );
}
