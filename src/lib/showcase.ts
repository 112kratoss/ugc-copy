export const SHOWCASE_PAGE_SIZE = 12;

export type ShowcaseCategory = 'all' | 'image' | 'video' | 'motion' | 'ugc-ad' | 'text';
export type ShowcaseSort = 'recent' | 'top-saves' | 'top-remixes';
export type ShowcaseItemCategory = Exclude<ShowcaseCategory, 'all'>;
export type ShowcaseSourceKind = 'ugc_copy' | 'external' | 'manual';
export type ShowcaseAssetType = 'workflow' | 'prompt_pack' | 'guide';
export type ShowcaseVisibility = 'public' | 'unlisted' | 'private';
export type ShowcasePostFormat = 'text' | 'media' | 'mixed';
export type ShowcaseMediaKind = 'image' | 'video';

export interface ShowcaseCreator {
    id: string | null;
    username: string | null;
    name: string;
    avatar: string | null;
}

export interface ShowcaseAssetSummary {
    id: string;
    type: ShowcaseAssetType;
    title: string;
    priceUsdCents: number;
}

export interface ShowcaseFeedItem {
    id: string;
    mediaUrl: string | null;
    mediaKind: ShowcaseMediaKind | null;
    model: string;
    title: string;
    prompt: string;
    body: string;
    category: ShowcaseItemCategory;
    postFormat: ShowcasePostFormat;
    saveCount: number;
    remixCount: number;
    createdAt: string;
    creator: ShowcaseCreator;
    isSaved?: boolean;
    sourceKind: ShowcaseSourceKind;
    sourceTool: string | null;
    generationId: string | null;
    asset: ShowcaseAssetSummary | null;
    canRemix: boolean;
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
    if (value === 'image' || value === 'video' || value === 'motion' || value === 'ugc-ad' || value === 'text') {
        return value;
    }

    return 'all';
}

export function isShowcaseItemCategory(value: string | null | undefined): value is ShowcaseItemCategory {
    return value === 'image' || value === 'video' || value === 'motion' || value === 'ugc-ad' || value === 'text';
}

export function isShowcaseMediaCategory(value: string | null | undefined): value is Exclude<ShowcaseItemCategory, 'text'> {
    return value === 'image' || value === 'video' || value === 'motion' || value === 'ugc-ad';
}

export function getShowcaseMediaKind(
    category: ShowcaseItemCategory,
    postFormat: ShowcasePostFormat
): ShowcaseMediaKind | null {
    if (postFormat === 'text' || category === 'text') {
        return null;
    }

    return category === 'video' || category === 'motion' ? 'video' : 'image';
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
