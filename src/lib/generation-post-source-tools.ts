import { getPostModelDisplayName } from '@/lib/post-feed-presentation';
import type { SourceToolSelection } from '@/lib/source-tools';

/**
 * A creation post's Made with: the app, and the creation's model by the name
 * its post prints, or no model where that name is missing, as it is for a
 * template result (`template-workflow`), whose model is its author's. It is
 * the creation's, never a request's: both composers show it locked, and an
 * edit drops a creation post's source fields (`GENERATION_DERIVED_FIELDS`).
 * Publishing stores it, and the owner's read derives it for a post stored
 * without one.
 */
export function buildGenerationPostSourceTools(
  post: { source_tool: string | null; source_tool_slug: string | null },
  /** As `shownGenerationModel` gives it: never a template result's own. */
  shownModel: string,
): SourceToolSelection[] {
  const modelLabel = getPostModelDisplayName(shownModel);
  return [{
    toolLabel: post.source_tool || 'magicbooklet',
    toolSlug: post.source_tool_slug || 'magicbooklet',
    modelLabel,
    modelSlug: modelLabel ? shownModel : null,
  }];
}
