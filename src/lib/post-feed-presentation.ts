import type { ShowcaseFeedItem } from '@/lib/showcase';
import {
    OWN_RECIPE_LABEL,
    RECIPE_UNLOCKED_LABEL,
    getAssetAccessLabel,
    isFreeRecipeAsset,
} from '@/lib/showcase-asset-labels';

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
 *
 * Nothing here reads the model tables: the names a post gives its model and tool are in
 * `post-model-labels.ts`, and the card built from these rules, whose metadata line names the
 * model, is in `post-feed-card.ts` (2026-11-19: the tables were 40 KB of every post page's
 * first load). `post-page-first-load-imports.test.ts` keeps them out.
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

/**
 * The earliest moment that draws the same `formatRelativeTime` label as `now`:
 * the start of the label's own unit counted from `value` (its minute, hour,
 * day or week), or the first day of its month or year band. A cached page that
 * drew an age at "now" changed its HTML at every refresh, and Vercel writes the
 * cache again for any change (a busy post page up to every five minutes); drawn
 * at this moment, the page is the same until the label itself moves. Ages are
 * read in whole seconds, rounded, as the label reads them, so the moment can be
 * up to half a second after `now`. The browser takes over with its own clock
 * after hydration (`PostRelativeTime`).
 */
export function relativeTimeLabelInstant(value: string, now: number): number {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp) || now <= timestamp) return now;
    const MINUTE = 60_000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    // formatRelativeTime reads whole seconds, rounded: so does this.
    const age = Math.round((now - timestamp) / 1000) * 1000;
    // Under a minute it reads "now", as it does at the post's own moment.
    if (age < MINUTE) return timestamp;
    if (age < 35 * DAY) {
        // Its m, h, d and w bands, each counted in its own unit.
        const step = age < HOUR ? MINUTE : age < DAY ? HOUR : age < 7 * DAY ? DAY : 7 * DAY;
        return timestamp + Math.floor(age / step) * step;
    }
    // Months (30 days) from 35 days, years (365 days) from 360: the first day of
    // the band the label is in.
    const days = Math.floor(age / DAY);
    const months = Math.floor(days / 30);
    const firstDay = months < 12 ? Math.max(35, months * 30) : Math.max(360, Math.floor(days / 365) * 365);
    return timestamp + firstDay * DAY;
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
    /** `Free recipe`, the price as this viewer pays it, `Unlocked` or `Your recipe`. */
    label: string;
    tone: 'free' | 'paid';
    /**
     * What the chip says, which picks its icon: a price, a free recipe, one
     * the viewer has (a check), or the viewer's own.
     */
    kind: 'price' | 'free' | 'unlocked' | 'owner';
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
    item: Pick<ShowcaseFeedItem, 'generationId' | 'canRemix' | 'remixCapability' | 'remixTarget'> & {
        asset: Pick<NonNullable<ShowcaseFeedItem['asset']>, 'allowRemix' | 'accessMode'> | null;
    },
): PostFeedRemixAccess | null {
    // Only a creation has a prompt and settings to start from, and the remix
    // route refuses any other post: one with none (a picture made elsewhere, a
    // text post) offers no Remix, whatever a read says of it (owner,
    // 2026-11-17), as the app's has never offered one.
    if (!item.generationId) return null;
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
 * - the viewer's own recipe says "Your recipe", and one they have (bought or
 *   opened free) "Unlocked", wherever it is, in place of the price it kept
 *   after buying (audit B-F2, 2026-10-27). The owner is asked first: whose
 *   post it is outranks whatever else is on record;
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
    item: Pick<ShowcaseFeedItem, 'asset' | 'generationId' | 'canRemix' | 'remixCapability' | 'remixTarget'>,
    viewer: { isOwner?: boolean } = {},
): PostFeedRecipeChip | null {
    if (!item.asset) return null;
    if (viewer.isOwner) return { label: OWN_RECIPE_LABEL, tone: 'free', kind: 'owner' };
    if (item.asset.viewerHasUnlocked) return { label: RECIPE_UNLOCKED_LABEL, tone: 'free', kind: 'unlocked' };
    const remixAccess = getPostFeedRemixAccess(item);

    if (!isFreeRecipeAsset(item.asset)) {
        return remixAccess === 'paid-unlock' ? null : { label: getAssetAccessLabel(item.asset), tone: 'paid', kind: 'price' };
    }

    return remixAccess ? null : { label: getAssetAccessLabel(item.asset), tone: 'free', kind: 'free' };
}

/** Width the feed column gives body text, used only for the line estimate (`post-feed-card.ts`). */
export const FEED_BODY_WIDTH = 620;
