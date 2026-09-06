import type { PublicPostDetail } from '@/lib/public-posts';

/**
 * Search-facing presentation for a single creation.
 *
 * Post titles are user input, and echoing them straight into `<title>` produced
 * pages titled "fake mask" and — on more than one URL at once — "Untitled
 * Creation". Duplicate and contentless titles are the two things most likely to
 * get a large body of otherwise-legitimate pages demoted, so the title is
 * composed from what the post actually is rather than repeated from the field.
 */

const PLACEHOLDER_TITLES = new Set([
    'untitled creation',
    'untitled',
    'untitled post',
    'new post',
    'creation',
    'test',
]);

const MIN_TITLE_LENGTH = 3;
/** Long enough for a full descriptive title, short enough to survive a SERP. */
const MAX_TITLE_LENGTH = 70;

export function hasMeaningfulTitle(title: string | null | undefined): boolean {
    const normalized = title?.trim().toLowerCase() ?? '';
    return normalized.length >= MIN_TITLE_LENGTH && !PLACEHOLDER_TITLES.has(normalized);
}

/**
 * Model identifiers arrive as slugs (`kling-v2-master`). Rendering the raw slug
 * in a title looks like a leaked internal, so it is spaced and cased — but not
 * aggressively rewritten, because the slug is what a person searching for that
 * model actually types.
 */
function formatModelName(model: string | null | undefined): string | null {
    const raw = model?.trim();
    if (!raw) return null;

    return raw
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (character) => character.toUpperCase());
}

function describeMediaKind(mediaKind: PublicPostDetail['mediaKind']): string {
    switch (mediaKind) {
        case 'video':
            return 'AI video';
        case 'image':
            return 'AI image';
        default:
            return 'AI creation';
    }
}

/**
 * The `<title>` for a creation, minus the site suffix that `createMetadata`
 * appends. A titled post keeps its own words and gains the context a searcher
 * needs; an untitled one is described entirely from its metadata rather than
 * sharing a placeholder with every other untitled post.
 */
export function composeShowcaseTitle(detail: PublicPostDetail): string {
    const mediaLabel = describeMediaKind(detail.mediaKind);
    const modelName = formatModelName(detail.model);

    if (hasMeaningfulTitle(detail.title)) {
        const base = detail.title.trim();
        const suffix = modelName
            ? `${mediaLabel} made with ${modelName}`
            : mediaLabel;
        const composed = `${base} — ${suffix}`;

        return composed.length <= MAX_TITLE_LENGTH ? composed : base;
    }

    // No usable title: build one that at least distinguishes this post from the
    // next untitled one by naming the model that produced it.
    const creatorHandle = detail.creator?.username;
    if (modelName && creatorHandle) {
        return `${mediaLabel} made with ${modelName} by @${creatorHandle}`;
    }
    if (modelName) {
        return `${mediaLabel} made with ${modelName}`;
    }

    return creatorHandle ? `${mediaLabel} by @${creatorHandle}` : mediaLabel;
}

/**
 * Whether a creation should enter the index.
 *
 * Mirrors the sitemap gate in `sitemap-entries.ts` — the two must agree, or the
 * site submits URLs that then tell the crawler not to index them. Unlisted posts
 * are reachable by link but are not meant to be discoverable, so they are
 * followed for their links and never indexed.
 */
export function isShowcaseDetailIndexable(detail: PublicPostDetail): boolean {
    if (detail.visibility !== 'public') {
        return false;
    }

    const hasMedia = Boolean(detail.mediaUrl || detail.mediaItems?.length);
    if (!hasMedia) {
        return false;
    }

    return hasMeaningfulTitle(detail.title);
}
