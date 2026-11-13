import { getPostModelDisplayName } from '@/lib/post-feed-presentation';
import type { PublicPostDetail } from '@/lib/public-posts';
import { isAppSourceToolLabel } from '@/lib/source-tools';

type MadeWithFields = Pick<PublicPostDetail, 'model' | 'sourceTool' | 'postFormat' | 'category' | 'mediaUrl'>;

/**
 * A post with no media is a text post, whatever its format says: it names no
 * model and is no AI creation.
 */
export function isTextOnlyPost(post: Pick<PublicPostDetail, 'postFormat' | 'category' | 'mediaUrl'>): boolean {
    return (post.postFormat === 'text' || post.category === 'text') && !post.mediaUrl;
}

/**
 * What a post was made with, as its page's Made with line says it and its
 * title and description repeat it: a catalog model by the name the feed card
 * gives it (`getPostModelDisplayName`; a retired model's slug is no name), else
 * an outside tool its creator named, as they wrote it, unless that is this
 * app's own name: posts made here record the app as their tool, and its own
 * name says nothing on its own page (the app's post Details leave it out the
 * same way, `isOwnTool` in ugc-mobile/lib/post-details-view-model.ts).
 * Nothing for a text post, as its card names no model either.
 * Kept here, not in `post-feed-presentation`, so the feed's cards do not load
 * the source-tool catalog to read it.
 */
export function getPostMadeWithLabel(post: MadeWithFields): string | null {
    if (isTextOnlyPost(post)) return null;

    const outsideTool = post.sourceTool?.trim();
    return getPostModelDisplayName(post.model)
        ?? (outsideTool && !isAppSourceToolLabel(outsideTool) ? outsideTool : null);
}
