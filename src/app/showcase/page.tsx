import ShowcaseClient from '@/app/showcase/ShowcaseClient';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import {
    SHOWCASE_PAGE_SIZE,
    normalizeShowcaseCategory,
    normalizeShowcaseOffset,
    normalizeShowcaseSort,
} from '@/lib/showcase';

type ShowcasePageProps = {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getFirstValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
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
