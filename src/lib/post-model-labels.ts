import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/client-generation-models';
import { getPostCategoryLabel, type PostPreviewKind } from '@/lib/post-feed-presentation';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { isAppSourceToolLabel } from '@/lib/source-tools';

/**
 * The names a post gives what made it. A module of its own because they read the browser's model
 * tables (`client-generation-models.ts`) and the outside tools' (`source-tools.ts`), about 40 KB
 * that `post-feed-presentation.ts` brought to every page importing it: the post page draws its Made
 * with on the server, and its browser code has no use for either.
 */

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
 * What a post was made with, by the name a person reads: its model by the
 * name the feed card gives it (`getPostModelDisplayName`), else an outside
 * tool its creator named (never the app's own name, which says nothing on its
 * own page). Nothing on a text post, whose card names no model either. The
 * post page's "Made with" and the search card's line read it.
 */
export function getPostMadeWithLabel(
    item: Pick<ShowcaseFeedItem, 'model' | 'sourceTool' | 'postFormat' | 'category' | 'mediaUrl'>,
): string | null {
    if ((item.postFormat === 'text' || item.category === 'text') && !item.mediaUrl) return null;
    // Posts made here record the app as their tool; the app's post Details
    // leave it out the same way (`isAppSourceToolLabel` in ugc-mobile/lib/app-source-tool.ts).
    const outsideTool = item.sourceTool?.trim();
    return getPostModelDisplayName(item.model)
        ?? (outsideTool && !isAppSourceToolLabel(outsideTool) ? outsideTool : null);
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
