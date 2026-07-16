import type { Metadata } from 'next';

import ShowcaseBootstrapClient from '@/app/showcase/ShowcaseBootstrapClient';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import { listSourceToolsCatalog } from '@/lib/source-tools-server';
import {
    SHOWCASE_INITIAL_PAGE_SIZE,
    SHOWCASE_INITIAL_RENDER_COUNT,
    SHOWCASE_PAGE_SIZE,
    normalizeShowcaseCategory,
    normalizeShowcaseOffset,
    normalizeShowcaseResourceFilter,
    normalizeShowcaseSort,
    normalizeShowcaseUnlockFilter,
    type ShowcaseFeedPage,
    type ShowcasePriorityPosterData,
} from '@/lib/showcase';
import { createMetadata } from '@/lib/seo';
import { buildOptimizedPreviewImageUrl } from '@/lib/preview-images';
import { getInlineShowcasePriorityPoster } from '@/lib/showcase-priority-poster';

type ShowcasePageProps = {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const SHOWCASE_PARAM_KEYS = new Set(['category', 'sort', 'offset', 'page', 'tool', 'unlock', 'resource']);

// This page is query-dynamic. The viewer-neutral feed loaders own their TTLs.

function getFirstValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function getPriorityVideoPoster(feed: ShowcaseFeedPage): {
    postId: string;
    mediaId: string;
    sourceUrl: string;
    preloadUrl: string;
} | null {
    const priorityItem = feed.items.slice(0, SHOWCASE_INITIAL_RENDER_COUNT).find((item) => (
        item.postFormat !== 'text'
        && (Boolean(item.mediaItems?.length) || Boolean(item.mediaUrl && item.mediaKind))
    ));
    if (!priorityItem) {
        return null;
    }

    const cover = priorityItem.mediaItems
        ?.slice()
        .sort((left, right) => left.sortOrder - right.sortOrder)[0];
    return cover?.mediaKind === 'video' && cover.previewUrl
        ? {
            postId: priorityItem.id,
            mediaId: cover.id,
            sourceUrl: cover.previewUrl,
            preloadUrl: buildOptimizedPreviewImageUrl(cover.previewUrl),
        }
        : null;
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
        (typeof rawSort === 'string' && sort !== 'for-you') ||
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
    const initialLimit = offset === 0 ? SHOWCASE_INITIAL_PAGE_SIZE : SHOWCASE_PAGE_SIZE;

    const initialFeedPromise = getShowcaseFeedPage({
        category,
        sort,
        offset,
        limit: initialLimit,
        viewerUserId: null,
        tool,
        unlock,
        resource,
        countryCode: null,
    });
    const sourceToolOptionsPromise = listSourceToolsCatalog();
    const initialFeed = await initialFeedPromise;
    const priorityVideoPoster = getPriorityVideoPoster(initialFeed);
    const [sourceToolOptions, inlinePosterDataUrl] = await Promise.all([
        sourceToolOptionsPromise,
        priorityVideoPoster
            ? getInlineShowcasePriorityPoster(priorityVideoPoster.sourceUrl)
            : Promise.resolve(null),
    ]);
    const initialPriorityPoster: ShowcasePriorityPosterData | null = priorityVideoPoster && inlinePosterDataUrl
        ? {
            postId: priorityVideoPoster.postId,
            mediaId: priorityVideoPoster.mediaId,
            dataUrl: inlinePosterDataUrl,
        }
        : null;

    return (
        <>
            {priorityVideoPoster && !initialPriorityPoster ? (
                <link
                    rel="preload"
                    as="image"
                    href={priorityVideoPoster.preloadUrl}
                    fetchPriority="high"
                />
            ) : null}
            <ShowcaseBootstrapClient
                initialFeed={initialFeed}
                initialCategory={category}
                initialSort={sort}
                initialTool={tool}
                initialUnlock={unlock}
                initialResource={resource}
                sourceToolOptions={sourceToolOptions}
                initialPriorityPoster={initialPriorityPoster}
            />
        </>
    );
}
