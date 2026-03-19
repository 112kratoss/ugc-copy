export const SHOWCASE_PAGE_SIZE = 12;

export type ShowcaseCategory = 'all' | 'image' | 'video' | 'motion' | 'ugc-ad';
export type ShowcaseSort = 'recent' | 'top-saves' | 'top-remixes';
export type ShowcaseItemCategory = Exclude<ShowcaseCategory, 'all'>;

export interface ShowcaseCreator {
    id: string | null;
    name: string;
    avatar: string | null;
}

export interface ShowcaseFeedItem {
    id: string;
    url: string;
    model: string;
    title: string;
    prompt: string;
    category: ShowcaseItemCategory;
    saveCount: number;
    remixCount: number;
    createdAt: string;
    creator: ShowcaseCreator;
}

export interface ShowcaseFeedPageInfo {
    hasMore: boolean;
    nextOffset: number | null;
    limit: number;
    offset: number;
}

export interface ShowcaseFeedPage {
    items: ShowcaseFeedItem[];
    pageInfo: ShowcaseFeedPageInfo;
}

export function normalizeShowcaseCategory(value: string | null | undefined): ShowcaseCategory {
    if (value === 'image' || value === 'video' || value === 'motion' || value === 'ugc-ad') {
        return value;
    }

    return 'all';
}

export function normalizeShowcaseSort(value: string | null | undefined): ShowcaseSort {
    if (value === 'top-saves' || value === 'top-remixes') {
        return value;
    }

    return 'recent';
}

export function parsePositiveInt(value: string | null | undefined, fallback: number): number {
    if (!value) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }

    return parsed;
}

export function normalizeShowcaseOffset(
    offsetValue: string | null | undefined,
    pageValue: string | null | undefined,
    limit: number
): number {
    if (offsetValue) {
        return parsePositiveInt(offsetValue, 0);
    }

    if (!pageValue) {
        return 0;
    }

    const page = Math.max(1, parsePositiveInt(pageValue, 1));
    return (page - 1) * limit;
}
