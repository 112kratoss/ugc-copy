import { getPostMadeWithLabel } from '@/lib/post-feed-presentation';
import type { PublicPostDetail } from '@/lib/public-posts';
import { siteConfig } from '@/lib/seo';
import { GENERIC_SUGGESTED_TITLES } from '../../ugc-mobile/lib/post-publish-policy/post-publish-policy';

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
    // What a text post with no title and no body reads (`getPublicPostDetail`).
    'untitled note',
    'untitled',
    'untitled post',
    'new post',
    'creation',
    'test',
    // What the composers suggest for a creation whose prompt gives no title
    // ("AI image", "Image recipe"): shared by many posts, so never a page title.
    ...GENERIC_SUGGESTED_TITLES,
]);

const MIN_TITLE_LENGTH = 3;
/** Long enough for a full descriptive title, short enough to survive a SERP. */
const MAX_TITLE_LENGTH = 70;

export function hasMeaningfulTitle(title: string | null | undefined): boolean {
    const normalized = title?.trim().toLowerCase() ?? '';
    return normalized.length >= MIN_TITLE_LENGTH && !PLACEHOLDER_TITLES.has(normalized);
}

/**
 * What the post is, in a word or two. A creation made here (it has a
 * generation) is an "AI image" or "AI video"; an upload was made elsewhere,
 * perhaps with a camera, so it is an "image" or "video" and claims nothing
 * about AI. A text post is a "post".
 */
/** A post with no media is a text post, as its page reads it (`ShowcaseDetailBody`). */
function isTextOnlyPost(detail: PublicPostDetail): boolean {
    return (detail.postFormat === 'text' || detail.category === 'text') && !detail.mediaUrl;
}

function describePostKind(detail: PublicPostDetail): string {
    if (isTextOnlyPost(detail)) return 'post';

    const prefix = detail.generationId ? 'AI ' : '';
    switch (detail.mediaKind) {
        case 'video':
            return `${prefix}video`;
        case 'image':
            return `${prefix}image`;
        default:
            return `${prefix}creation`;
    }
}

function withArticle(noun: string): string {
    return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

function capitalize(text: string): string {
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "an AI video made with Seedance 2.5 by @aria", each part only where known. */
function describePost(detail: PublicPostDetail, kind: string): string {
    const madeWith = getPostMadeWithLabel(detail);
    const creatorHandle = detail.creator?.username;
    return [
        kind,
        madeWith ? `made with ${madeWith}` : null,
        creatorHandle ? `by @${creatorHandle}` : null,
    ].filter(Boolean).join(' ');
}

/**
 * The `<title>` for a creation, minus the site suffix that `createMetadata`
 * appends. A titled post keeps its own words and gains the context a searcher
 * needs; an untitled one is described entirely from its metadata rather than
 * sharing a placeholder with every other untitled post. A text post's title is
 * its own words alone. The model is named as the page's Made with line names
 * it (`getPostMadeWithLabel`, which the search cards read too), and only where
 * that line does.
 */
export function composeShowcaseTitle(detail: PublicPostDetail): string {
    const kind = describePostKind(detail);

    if (hasMeaningfulTitle(detail.title)) {
        const base = detail.title.trim();
        if (isTextOnlyPost(detail)) return base;

        const madeWith = getPostMadeWithLabel(detail);
        const composed = `${base} — ${madeWith ? `${kind} made with ${madeWith}` : kind}`;
        return composed.length <= MAX_TITLE_LENGTH ? composed : base;
    }

    // No usable title: build one that at least distinguishes this post from the
    // next untitled one by naming the model that produced it and its creator.
    return capitalize(describePost(detail, kind));
}

/**
 * The meta description for a creation with no words of its own (no
 * description, body or public prompt): what it is, then what its recipe holds.
 * Its recipe line alone ("Includes the prompt.") was every such post's whole
 * description, the same 20 characters on many pages. Never reads a prompt: a
 * post with a recipe has none in its public read.
 */
export function composeShowcaseDescription(detail: PublicPostDetail): string {
    const whatItIs = describePost(detail, withArticle(describePostKind(detail)));
    const sentence = hasMeaningfulTitle(detail.title)
        ? leadWithTitle(detail.title.trim(), whatItIs)
        : `${capitalize(whatItIs)} on ${siteConfig.name}.`;

    const recipeLine = detail.resourceBundle?.summary?.trim() || detail.resourceBundle?.previewText?.trim();
    return recipeLine ? `${sentence} ${recipeLine}` : sentence;
}

/**
 * "Mahabali, an AI image … on Magic Booklet." A title that ends a sentence
 * ("Golden hour.", "Wow!") is left one, and what follows starts the next;
 * trailing commas, colons and dashes give way to the comma.
 */
function leadWithTitle(title: string, whatItIs: string): string {
    const base = title.replace(/[\s,;:\u2013\u2014-]+$/u, '');
    return /[.!?\u2026]["'\u201d\u2019)]*$/u.test(base)
        ? `${base} ${capitalize(whatItIs)} on ${siteConfig.name}.`
        : `${base}, ${whatItIs} on ${siteConfig.name}.`;
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
