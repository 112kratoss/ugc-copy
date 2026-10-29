import { createStoredRows } from '@/__tests__/fixtures/stored-rows';

/**
 * What a generation start reads before it credits a run to someone else's
 * public source (`source-generation.ts`, asking `remix-access.ts`): the
 * caller's linked accounts, the source's post, any block between the two and a
 * recipe on the post. The post is exposed as the feed shows it, with no recipe,
 * so the run is credited unless `blocks` says otherwise.
 */
export function createRemixSourceRows(
  source: { id: string; user_id: string } | null,
  { blocks = [] }: { blocks?: Array<{ blocker_user_id: string; blocked_user_id: string }> } = {},
) {
  return createStoredRows({
    profiles: [],
    posts: source
      ? [{
        id: `post-of-${source.id}`,
        user_id: source.user_id,
        generation_id: source.id,
        category: 'image',
        post_format: 'media',
        source_kind: 'magicbooklet',
        visibility: 'public',
        archived_at: null,
        review_status: 'visible',
      }]
      : [],
    user_blocks: blocks,
    post_resource_bundles: [],
    post_resource_bundle_purchases: [],
  });
}
