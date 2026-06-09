import type { Metadata } from 'next';

import ShowcaseClient from '@/app/showcase/ShowcaseClient';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import { listSourceToolsCatalog } from '@/lib/source-tools-server';
import {
    SHOWCASE_PAGE_SIZE,
    normalizeShowcaseCategory,
    normalizeShowcaseOffset,
    normalizeShowcaseResourceFilter,
    normalizeShowcaseSort,
    normalizeShowcaseUnlockFilter,
} from '@/lib/showcase';
import { createMetadata } from '@/lib/seo';

type ShowcasePageProps = {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const SHOWCASE_PARAM_KEYS = new Set(['category', 'sort', 'offset', 'page', 'tool', 'unlock', 'resource']);

export const revalidate = 60;

function getFirstValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ searchParams }: ShowcasePageProps): Promise<Metadata> {
    const resolvedSearchParams = searchParams ? await searchParams : {};
    const rawCategory = getFirstValue(resolvedSearchParams.category);
    const rawSort = getFirstValue(resolvedSearchParams.sort);
    const rawOffset = getFirstValue(resolvedSearchParams.offset);
    const rawPage = getFirstValue(resolvedSearchParams.page);
    const rawTool = getFirstValue(resolvedSearchParams.tool);
    const rawUnlock = getFirstValue(resolvedSearchParams.unlock);
    const rawResource = getFirstValue(resolvedSearchParams.resource);

    const category = normalizeShowcaseCategory(rawCategory);
    const sort = normalizeShowcaseSort(rawSort);
    const offset = normalizeShowcaseOffset(rawOffset, rawPage, SHOWCASE_PAGE_SIZE);
    const hasUnknownQuery = Object.keys(resolvedSearchParams).some((key) => !SHOWCASE_PARAM_KEYS.has(key));
    const hasNonDefaultVariant =
        hasUnknownQuery ||
        (typeof rawCategory === 'string' && category !== 'all') ||
        (typeof rawSort === 'string' && sort !== 'recent') ||
        typeof rawTool === 'string' ||
        (typeof rawUnlock === 'string' && normalizeShowcaseUnlockFilter(rawUnlock) !== 'all') ||
        (typeof rawResource === 'string' && normalizeShowcaseResourceFilter(rawResource) !== 'all') ||
        offset > 0;

    return createMetadata({
        title: 'Showcase',
        description:
            'Browse public magicbooklet creations, creator notes, and production-ready examples of AI images, videos, motion-transfer ads, and reusable workflows.',
        path: '/showcase',
        keywords: ['AI showcase', 'UGC ad examples', 'AI image examples', 'AI video examples', 'creator tips'],
        noIndex: hasNonDefaultVariant,
    });
}

export default async function ShowcasePage({ searchParams }: ShowcasePageProps) {
    const resolvedSearchParams = searchParams ? await searchParams : {};
    const category = normalizeShowcaseCategory(getFirstValue(resolvedSearchParams.category));
    const sort = normalizeShowcaseSort(getFirstValue(resolvedSearchParams.sort));
    const tool = getFirstValue(resolvedSearchParams.tool) ?? null;
    const unlock = normalizeShowcaseUnlockFilter(getFirstValue(resolvedSearchParams.unlock));
    const resource = normalizeShowcaseResourceFilter(getFirstValue(resolvedSearchParams.resource));
    const offset = normalizeShowcaseOffset(
        getFirstValue(resolvedSearchParams.offset),
        getFirstValue(resolvedSearchParams.page),
        SHOWCASE_PAGE_SIZE
    );

    const [initialFeed, sourceToolOptions] = await Promise.all([
      getShowcaseFeedPage({
        category,
        sort,
        offset,
        limit: SHOWCASE_PAGE_SIZE,
        viewerUserId: null,
        tool,
        unlock,
        resource,
        countryCode: null,
      }),
      listSourceToolsCatalog(),
    ]);

    return (
        <ShowcaseClient
            initialFeed={initialFeed}
            initialCategory={category}
            initialSort={sort}
            initialTool={tool}
            initialUnlock={unlock}
            initialResource={resource}
            sourceToolOptions={sourceToolOptions}
        />
    );
}
