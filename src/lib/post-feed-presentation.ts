import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/client-generation-models';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { getAssetAccessLabel, isFreeRecipeAsset } from '@/lib/showcase-asset-labels';

/**
 * How a post presents in a single-column feed.
 *
 * This mirrors `ugc-mobile/lib/home-feed-view-model.ts` on purpose: the two
 * clients share no code, so the rules are duplicated and each side unit-tests
 * them. Change one, change the other — `post-feed-presentation.test.ts` and
 * `home-feed-view-model.test.ts` assert the same cases.
 *
 * Deliberate divergence (2026-08): web presents a text post Reddit-style — an
 * unframed six-line clamp with no "Read more", because the whole card already
 * opens the post. Mobile keeps its framed eight-line body with in-place
 * expansion, where there is no equivalent whole-card affordance.
 */
export type PostPreviewKind = 'media' | 'text' | 'mixed';

const TEXT_BODY_CLAMP_LINES = 6;
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

/** Structural pick so the post detail page (a different DTO) can reuse it. */
export function getPostFeedTitle(
    item: Pick<ShowcaseFeedItem, 'title' | 'prompt' | 'body' | 'creationMode' | 'mediaKind' | 'category'>,
    kind: PostPreviewKind
) {
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
    categoryLabel: string;
    /**
     * Creation context for media posts — `Image · GPT Image 2` — shown under
     * the title instead of the old type chip. Null for text posts, which keep
     * the chip (they have no model).
     */
    metadataLabel: string | null;
    creatorLabel: string;
    timeLabel: string;
    saveLabel: string;
    commentLabel: string;
    /** What a tap on Remix has to get through first; null when the card has no Remix. */
    remixAccess: PostFeedRemixAccess | null;
    /** `Remix`, with its count; behind a paid unlock, the unlock's price. */
    remixLabel: string;
    /** The recipe behind the post, where the action row has reason to name it. */
    recipeChip: PostFeedRecipeChip | null;
    canExpandBody: boolean;
}

export interface PostFeedRecipeChip {
    /** `Free recipe`, or the price as this viewer pays it. */
    label: string;
    tone: 'free' | 'paid';
}

/**
 * What stands between the viewer and remixing a post: nothing (`open`), or a
 * recipe the creator sells the remix with, which costs nothing
 * (`free-unlock`, taken in the Remix tap itself) or costs something
 * (`paid-unlock`, sold on the post's recipe). The web reel draws Remix on the
 * same rule, and the app decides the same three
 * (ugc-mobile/lib/showcase-remix-access.ts).
 */
export type PostFeedRemixAccess = 'open' | 'free-unlock' | 'paid-unlock';

export function getPostFeedRemixAccess(
    item: Pick<ShowcaseFeedItem, 'asset' | 'canRemix' | 'remixCapability' | 'remixTarget'>,
): PostFeedRemixAccess | null {
    if (item.canRemix) return 'open';
    if (item.remixCapability !== 'unlock_required' || !item.asset?.allowRemix) return null;
    // Workflow and text-template remixes stay out, as the server's own
    // `canRemix` leaves them out.
    if (item.remixTarget === 'workflow' || item.remixTarget === 'text_template') return null;
    // The free unlock takes only a recipe that is free by its mode.
    return item.asset.accessMode === 'free' ? 'free-unlock' : 'paid-unlock';
}

/**
 * The recipe behind a post, as a chip at the end of the card's action row. It
 * is drawn only where it says something the row does not already:
 *
 * - a paid recipe always shows its price, so a post that sells something is
 *   visible while scrolling. Where the recipe is what locks Remix, the locked
 *   Remix carries the price instead, and there is no second pill;
 * - a free one shows only on a card with no Remix, where it is the one way to
 *   the prompt. Beside Remix it would say nothing Remix does not: that tap
 *   takes a free unlock on its way.
 *
 * It replaced a full-width bar under the media that repeated the post's title.
 * Mirrors `homeRecipeChip` in ugc-mobile/lib/home-feed-view-model.ts;
 * `contracts/feed-recipe-chip-v1.json` holds both to the same cases.
 */
export function getPostFeedRecipeChip(
    item: Pick<ShowcaseFeedItem, 'asset' | 'canRemix' | 'remixCapability' | 'remixTarget'>,
): PostFeedRecipeChip | null {
    if (!item.asset) return null;
    const remixAccess = getPostFeedRemixAccess(item);

    if (!isFreeRecipeAsset(item.asset)) {
        return remixAccess === 'paid-unlock' ? null : { label: getAssetAccessLabel(item.asset), tone: 'paid' };
    }

    return remixAccess ? null : { label: getAssetAccessLabel(item.asset), tone: 'free' };
}

/** Width the feed column gives body text, used only for the line estimate. */
export const FEED_BODY_WIDTH = 620;
/** Every kind renders its body at the same size; only the estimate reads this. */
const BODY_FONT_SIZE = 14;

/**
 * Model ids are internal slugs (`gpt-image-2`); creators should read the
 * product name. Unknown or manual sources return null so the metadata line
 * simply omits the model instead of leaking a slug.
 */
export function getPostModelDisplayName(model: string | null | undefined): string | null {
    if (!model) return null;

    const catalogEntry = (IMAGE_MODELS as Record<string, { displayName: string }>)[model]
        ?? (VIDEO_MODELS as Record<string, { displayName: string }>)[model]
        ?? (MOTION_MODELS as Record<string, { displayName: string }>)[model];

    return catalogEntry?.displayName ?? null;
}

/**
 * The creation-context line for media posts. Text posts return null — their
 * type chip stays, and they carry no model. It does not say the post can be
 * remixed: the card's Remix pill says so.
 */
export function getPostFeedMetadataLabel(item: ShowcaseFeedItem, kind: PostPreviewKind): string | null {
    if (kind === 'text') return null;

    const parts = [
        getPostCategoryLabel(item),
        getPostModelDisplayName(item.model),
    ].filter((part): part is string => Boolean(part));

    return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Count labels read as verbs until there is real social proof: a young feed
 * full of zeros looks abandoned, while "Save" reads as an invitation.
 */
function formatActionLabel(count: number | null | undefined, verb: string) {
    return (count ?? 0) > 0 ? formatCompactCount(count) : verb;
}

export function buildPostFeedCard(item: ShowcaseFeedItem, now = new Date()): PostFeedCard {
    const kind = resolvePostPreviewKind(item);
    const body = getPostFeedBody(item, kind);
    const clampLines = getPostBodyClampLines(kind);
    const creatorName = item.creator.name || item.creator.username || 'Creator';
    const remixAccess = getPostFeedRemixAccess(item);

    return {
        id: item.id,
        item,
        kind,
        title: getPostFeedTitle(item, kind),
        body,
        clampLines,
        categoryLabel: getPostCategoryLabel(item),
        metadataLabel: getPostFeedMetadataLabel(item, kind),
        creatorLabel: item.creator.username ? `@${item.creator.username}` : creatorName,
        timeLabel: formatRelativeTime(item.createdAt, now),
        saveLabel: formatActionLabel(item.saveCount, 'Save'),
        commentLabel: formatActionLabel(item.commentCount, 'Comment'),
        remixAccess,
        // A remix sold with its recipe wears the recipe's price, as the app's
        // locked Remix does: the lock says the rest.
        remixLabel: remixAccess === 'paid-unlock' && item.asset
            ? getAssetAccessLabel(item.asset)
            : item.remixCount > 0 ? `Remix · ${formatCompactCount(item.remixCount)}` : 'Remix',
        recipeChip: getPostFeedRecipeChip(item),
        // A text post never expands in place — the card itself opens the post,
        // so a clamped body ends in an ellipsis that reads as "there is more".
        canExpandBody: kind !== 'text'
            && estimateWrappedLineCount(body, FEED_BODY_WIDTH, BODY_FONT_SIZE) > clampLines,
    };
}

/**
 * Builds a lane's cards, keeping the card of an item it has built before. The
 * lane's array is new after every save, page and comment count while nearly
 * all of its items are the objects they were, and a new card for each of them
 * re-rendered every mounted card for the one that changed. The clock is a
 * card's one input besides its item, so a kept card whose time label has moved
 * on is built again (the app's Home cards are kept the same way).
 */
export function createPostFeedCardBuilder() {
    const cards = new WeakMap<ShowcaseFeedItem, PostFeedCard>();
    return (items: ShowcaseFeedItem[], now = new Date()): PostFeedCard[] => items.map((item) => {
        const kept = cards.get(item);
        if (kept && kept.timeLabel === formatRelativeTime(item.createdAt, now)) return kept;
        const card = buildPostFeedCard(item, now);
        cards.set(item, card);
        return card;
    });
}
