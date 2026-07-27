import type { ShowcaseFeedItem } from '@/lib/showcase';

/**
 * How a post presents in a single-column feed.
 *
 * This mirrors `ugc-mobile/lib/home-feed-view-model.ts` on purpose: the two
 * clients share no code, so the rules are duplicated and each side unit-tests
 * them. Change one, change the other — `post-feed-presentation.test.ts` and
 * `home-feed-view-model.test.ts` assert the same cases.
 */
export type PostPreviewKind = 'media' | 'text' | 'mixed';

const TEXT_BODY_CLAMP_LINES = 8;
const MIXED_BODY_CLAMP_LINES = 3;
const MEDIA_BODY_CLAMP_LINES = 2;

/** Mean glyph advance as a fraction of font size, used only to decide whether
 * "Read more" is worth offering. A wrong call costs a stray toggle, not layout. */
const AVERAGE_GLYPH_WIDTH_RATIO = 0.52;

const PLACEHOLDER_TITLE = /^(untitled(?: creation| note)?|community post)$/i;

export function isTextOnlyPost(item: Pick<ShowcaseFeedItem, 'category' | 'postFormat' | 'mediaUrl'>) {
    return (item.category === 'text' || item.postFormat === 'text') && !item.mediaUrl;
}

export function resolvePostPreviewKind(item: ShowcaseFeedItem): PostPreviewKind {
    if (!item.mediaUrl) return 'text';
    // The Showcase grid never renders a mixed post's body; the feed is the surface that does.
    if (item.postFormat === 'mixed' && item.body.trim()) return 'mixed';
    return 'media';
}

export function getPostFeedTitle(item: ShowcaseFeedItem, kind: PostPreviewKind) {
    const title = item.title?.trim();
    if (title && !PLACEHOLDER_TITLE.test(title)) return title;

    const fallback = kind === 'media' ? item.prompt : item.body || item.prompt;
    const clean = fallback?.trim();
    if (clean && !PLACEHOLDER_TITLE.test(clean)) return clean;

    if (item.creationMode === 'motion') return 'Motion creation';
    if (item.mediaKind === 'video' || item.category === 'video') return 'Video creation';
    if (kind === 'text') return 'Creator note';
    return 'Image creation';
}

export function getPostFeedBody(item: ShowcaseFeedItem, kind: PostPreviewKind) {
    const title = getPostFeedTitle(item, kind);
    const candidates = kind === 'media' ? [item.prompt, item.body] : [item.body, item.prompt];

    for (const candidate of candidates) {
        const clean = candidate?.trim();
        // Never repeat the line already shown as the title.
        if (clean && clean !== title) return clean;
    }

    return '';
}

export function getPostBodyClampLines(kind: PostPreviewKind) {
    if (kind === 'text') return TEXT_BODY_CLAMP_LINES;
    if (kind === 'mixed') return MIXED_BODY_CLAMP_LINES;
    return MEDIA_BODY_CLAMP_LINES;
}

/** A text post is the post, so it reads at body size in its own panel. */
export function isFramedPostBody(kind: PostPreviewKind) {
    return kind === 'text';
}

export function getPostCategoryLabel(item: ShowcaseFeedItem) {
    if (item.creationMode === 'motion') return 'Motion';
    if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
    if (item.category === 'text' || item.postFormat === 'text') return 'Text';
    return 'Image';
}

export function formatCompactCount(value: number | null | undefined) {
    const safeValue = Math.max(0, value ?? 0);
    if (safeValue >= 1_000_000) return `${trimOneDecimal(safeValue / 1_000_000)}M`;
    if (safeValue >= 1_000) return `${trimOneDecimal(safeValue / 1_000)}K`;
    return String(safeValue);
}

function trimOneDecimal(value: number) {
    return value.toFixed(1).replace(/\.0$/, '');
}

export function formatRelativeTime(value: string, now = new Date()) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return '';

    const seconds = Math.max(0, Math.round((now.getTime() - timestamp) / 1000));
    if (seconds < 60) return 'now';

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;

    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;

    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w`;

    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo`;

    return `${Math.floor(days / 365)}y`;
}

/**
 * Estimates how many lines `text` wraps to at `width`. CSS line clamping gives
 * no signal about whether anything was hidden, so the "Read more" affordance is
 * decided up front from the text itself rather than measured after paint.
 */
export function estimateWrappedLineCount(text: string, width: number, fontSize: number) {
    if (!text.trim() || width <= 0 || fontSize <= 0) return 0;

    const charactersPerLine = Math.max(1, Math.floor(width / (fontSize * AVERAGE_GLYPH_WIDTH_RATIO)));

    return text.split('\n').reduce((total, paragraph) => {
        const length = paragraph.trim().length;
        // An empty paragraph is still a rendered blank line.
        return total + Math.max(1, Math.ceil(length / charactersPerLine));
    }, 0);
}

export interface PostFeedCard {
    id: string;
    item: ShowcaseFeedItem;
    kind: PostPreviewKind;
    title: string;
    body: string;
    clampLines: number;
    framedBody: boolean;
    categoryLabel: string;
    creatorLabel: string;
    timeLabel: string;
    saveLabel: string;
    commentLabel: string;
    remixLabel: string;
    canExpandBody: boolean;
}

/** Width the feed column gives body text, used only for the line estimate. */
export const FEED_BODY_WIDTH = 620;
const TEXT_BODY_FONT_SIZE = 16;
const COMPACT_BODY_FONT_SIZE = 14;

export function getPostBodyFontSize(kind: PostPreviewKind) {
    return kind === 'text' ? TEXT_BODY_FONT_SIZE : COMPACT_BODY_FONT_SIZE;
}

export function buildPostFeedCard(item: ShowcaseFeedItem, now = new Date()): PostFeedCard {
    const kind = resolvePostPreviewKind(item);
    const body = getPostFeedBody(item, kind);
    const clampLines = getPostBodyClampLines(kind);
    const creatorName = item.creator.name || item.creator.username || 'Creator';

    return {
        id: item.id,
        item,
        kind,
        title: getPostFeedTitle(item, kind),
        body,
        clampLines,
        framedBody: isFramedPostBody(kind),
        categoryLabel: getPostCategoryLabel(item),
        creatorLabel: item.creator.username ? `@${item.creator.username}` : creatorName,
        timeLabel: formatRelativeTime(item.createdAt, now),
        saveLabel: formatCompactCount(item.saveCount),
        commentLabel: formatCompactCount(item.commentCount),
        remixLabel: formatCompactCount(item.remixCount),
        canExpandBody: estimateWrappedLineCount(body, FEED_BODY_WIDTH, getPostBodyFontSize(kind)) > clampLines,
    };
}

export function buildPostFeedCards(items: ShowcaseFeedItem[], now = new Date()) {
    return items.map((item) => buildPostFeedCard(item, now));
}
