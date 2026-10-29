import { createStoredRows } from '@/__tests__/fixtures/stored-rows';

type Row = Record<string, unknown>;
type Source = { id: string; user_id: string };

/** A source's post as the feed shows it: public, live, visible and the creator's own. */
export function exposedPostOf(source: Source) {
  return {
    id: `post-of-${source.id}`,
    user_id: source.user_id,
    generation_id: source.id,
    category: 'image',
    post_format: 'media',
    source_kind: 'magicbooklet',
    visibility: 'public',
    archived_at: null,
    review_status: 'visible',
  };
}

export type RemixSourceRowOptions = {
  /** The source's post, exposed by default. */
  posts?: Row[];
  /** `post_resource_bundles` rows: a recipe on the post. */
  recipes?: Row[];
  /** `post_resource_bundle_purchases` rows: who unlocked which recipe. */
  purchases?: Row[];
  /** `user_blocks` rows: who blocked whom. */
  blocks?: Array<{ blocker_user_id: string; blocked_user_id: string }>;
  /** Guest profiles and the account each was linked into. */
  profiles?: Array<{ id: string; merged_into_user_id: string }>;
};

/**
 * What a generation start reads before it credits a run to someone else's
 * public source (`source-generation.ts`, asking `remix-access.ts`): the
 * caller's linked accounts, the source's post, any block between the two, a
 * recipe on the post and who unlocked it. By default the post is exposed, with
 * no recipe and no block, so the run is credited.
 */
export function remixSourceTables(
  source: Source | null,
  {
    posts = source ? [exposedPostOf(source)] : [],
    recipes = [],
    purchases = [],
    blocks = [],
    profiles = [],
  }: RemixSourceRowOptions = {},
) {
  return {
    profiles,
    posts,
    user_blocks: blocks,
    post_resource_bundles: recipes,
    post_resource_bundle_purchases: purchases,
  };
}

/** Those tables as stored rows (`createStoredRows`), which refuse any other table. */
export function createRemixSourceRows(source: Source | null, options: RemixSourceRowOptions = {}) {
  return createStoredRows(remixSourceTables(source, options));
}
