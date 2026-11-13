import { getPostModelDisplayName } from '@/lib/post-feed-presentation';
import type { PublicPostDetail } from '@/lib/public-posts';
import { siteConfig } from '@/lib/seo';
import { TEMPLATE_RESULT_MODEL } from '@/lib/template-result';
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
 * Model ids that name no model: a template result's model is the template's,
 * and an upload whose creator named no tool reads `manual` or `external`.
 */
const UNNAMED_MODELS = new Set([TEMPLATE_RESULT_MODEL, 'manual', 'external']);

/**
 * A catalog model goes by the name the catalog gives it ("Seedance 2.5"), the
 * one the post page's Made with line prints and the one people search for.
 * Anything else (a retired model, an outside tool an upload named) arrives as a
 * slug or free text, which is spaced and cased rather than printed raw.
 */
function formatModelName(model: string | null | undefined): string | null {
    const raw = model?.trim();
    if (!raw || UNNAMED_MODELS.has(raw)) return null;

    const catalogName = getPostModelDisplayName(raw);
    if (catalogName) return catalogName;

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
 * The meta description for a creation with no words of its own (no
 * description, body or public prompt): what it is, then what its recipe holds.
 * Its recipe line alone ("Includes the prompt.") was every such post's whole
 * description, the same 20 characters on many pages. Never reads a prompt: a
 * post with a recipe has none in its public read.
 */
export function composeShowcaseDescription(detail: PublicPostDetail): string {
    const creatorHandle = detail.creator?.username;
    // Read as the post page reads it (`ShowcaseDetailBody`): no media, no model.
    const isTextPost = (detail.postFormat === 'text' || detail.category === 'text') && !detail.mediaUrl;
    const modelName = isTextPost ? null : formatModelName(detail.model);

    const whatItIs = [
        isTextPost ? 'a post' : `an ${describeMediaKind(detail.mediaKind)}`,
        modelName ? `made with ${modelName}` : null,
        creatorHandle ? `by @${creatorHandle}` : null,
    ].filter(Boolean).join(' ');
    const sentence = hasMeaningfulTitle(detail.title)
        ? `${detail.title.trim()}, ${whatItIs} on ${siteConfig.name}.`
        : `${whatItIs.charAt(0).toUpperCase()}${whatItIs.slice(1)} on ${siteConfig.name}.`;

    const recipeLine = detail.resourceBundle?.summary?.trim() || detail.resourceBundle?.previewText?.trim();
    return recipeLine ? `${sentence} ${recipeLine}` : sentence;
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
