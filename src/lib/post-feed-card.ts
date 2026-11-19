import {
    FEED_BODY_WIDTH,
    estimateWrappedLineCount,
    formatCompactCount,
    formatRelativeTime,
    getPostBodyClampLines,
    getPostCategoryLabel,
    getPostFeedBody,
    getPostFeedRecipeChip,
    getPostFeedRemixAccess,
    getPostFeedTitle,
    resolvePostPreviewKind,
    type PostFeedCard,
} from '@/lib/post-feed-presentation';
import { getPostFeedMetadataLabel } from '@/lib/post-model-labels';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { getRecipeOfferLabel } from '@/lib/showcase-asset-labels';

/**
 * A post's card in the feed, built from the rules in `post-feed-presentation.ts`. Apart from them
 * because its metadata line names the model (`post-model-labels.ts`), which reads the model tables.
 */

/** Every kind renders its body at the same size; only the estimate reads this. */
const BODY_FONT_SIZE = 14;

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
            ? getRecipeOfferLabel(item.asset)
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
