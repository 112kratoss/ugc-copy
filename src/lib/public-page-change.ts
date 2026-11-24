/**
 * Whether a write to one post may remove something from the cached public
 * pages (which then expire at once, `invalidateShowcaseFeedCache`) or only
 * changes them (refreshed in the background,
 * `invalidateShowcaseFeedAndRefreshPostPages`). Pure, so both the services
 * that save a post and their tests ask it.
 */

/** A post as the public pages see it, before or after a write. */
export type PostPageState = {
  visibility: string | null | undefined;
  /** `archived_at` is set. */
  archived?: boolean;
  /** Held by moderation (`review_status` other than visible) or tombstoned (deleted while it had buyers). */
  hidden?: boolean;
  isNsfw?: boolean;
};

/** A post row's columns as the state above reads them. */
export function postPageStateOfRow(row: {
  visibility?: string | null;
  archived_at?: string | null;
  review_status?: string | null;
  tombstoned_at?: string | null;
  is_nsfw?: boolean | null;
}): PostPageState {
  return {
    visibility: row.visibility,
    archived: Boolean(row.archived_at),
    hidden: Boolean(row.tombstoned_at) || (row.review_status ?? 'visible') !== 'visible',
    isNsfw: row.is_nsfw === true,
  };
}

/** Its page draws it (`getPublicPostDetail`): public or unlisted, not archived, not held. */
export function isPostPageDrawn(state: PostPageState | null): boolean {
  return Boolean(state)
    && (state?.visibility === 'public' || state?.visibility === 'unlisted')
    && !state?.archived
    && !state?.hidden;
}

/** The creator page, the storefront and remix credits list it or link it: public, not archived, not held. */
export function isPostListed(state: PostPageState | null): boolean {
  return isPostPageDrawn(state) && state?.visibility === 'public';
}

export type PostPageChange =
  /** Something shown is taken out of view: every cached page is expired at once. */
  | { kind: 'removal' }
  /** Nothing is taken out of view: the pages that draw the post are refreshed in the background. */
  | { kind: 'change'; arrived: boolean };

/**
 * What a write did to a post's public pages, from the post before it (null
 * for a post the write made) and after it.
 *
 * Judged by where the write leaves the post, whatever the read before it said:
 * a service reads the post at its start and writes it later, and another
 * request may have shown the post in between (review, 2026-11-17). So a write
 * that leaves the post anywhere but public, visible and uncovered is a
 * removal: private, unlisted (off the lists), archived, held by moderation,
 * or behind the mature cover (its media leave public storage then too). It
 * expires every cached page at once, as before background refreshes, even
 * when the read said nothing was shown: an edit of a private or covered post
 * wipes. Everything else is a change, and `arrived` says the post came onto
 * its page with it: the page could only hold a not-found until now.
 */
export function classifyPostPageChange(before: PostPageState | null, after: PostPageState): PostPageChange {
  if (!isPostListed(after) || after.isNsfw) return { kind: 'removal' };
  return { kind: 'change', arrived: !isPostPageDrawn(before) };
}

/**
 * The post columns a feed card or the home shelf draws as words or as its
 * remix button (`resolvePostRowsToFeedItems` in `showcase-feed.ts`): the title,
 * prompt, caption and body, the category and post format that pick its lane
 * and its layout, the tool it names, and whether it offers a remix.
 */
export const FEED_DRAWN_POST_COLUMNS = [
  'title',
  'description',
  'prompt',
  'body',
  'post_format',
  'category',
  'source_tool',
  'source_tool_slug',
  'remixes_allowed',
] as const;

/** A recipe as its card draws it: the access, the price and the locked preview's words and items. */
export type FeedDrawnRecipe = {
  accessMode?: string | null;
  priceUsdCents?: number | null;
  summary?: string | null;
  previewText?: string | null;
  resources?: unknown;
};

function drawnRecipe(recipe: FeedDrawnRecipe | null | undefined): string {
  if (!recipe || !recipe.accessMode || recipe.accessMode === 'none') return 'none';
  return JSON.stringify([
    recipe.accessMode,
    recipe.priceUsdCents ?? null,
    recipe.summary ?? null,
    recipe.previewText ?? null,
    recipe.resources ?? null,
  ]);
}

/**
 * Whether an edit changes words a cached feed card draws (review of #918): a
 * listed post's old title, prompt, caption or price must not be served once
 * more after the creator edits it out, so such an edit expires the feeds at
 * once. Only an edit that provably leaves every drawn column and the recipe as
 * they were (a media-only edit, which restates them) is refreshed in the
 * background. A column the save writes but the read before it did not hold,
 * or a recipe the save names that differs in any way from the stored one,
 * counts as changed: when the code cannot tell, the feeds expire at once.
 */
export function editChangesFeedText({ before, patch, recipeBefore, recipeAfter }: {
  before: Readonly<Record<string, unknown>>;
  patch: Readonly<Record<string, unknown>>;
  recipeBefore?: FeedDrawnRecipe | null;
  /** Left out when the save names no recipe (it keeps the stored one). */
  recipeAfter?: FeedDrawnRecipe | null;
}): boolean {
  const columnChanged = FEED_DRAWN_POST_COLUMNS.some((column) => {
    if (!Object.prototype.hasOwnProperty.call(patch, column)) return false;
    if (!Object.prototype.hasOwnProperty.call(before, column)) return true;
    return (patch[column] ?? null) !== (before[column] ?? null);
  });
  if (columnChanged) return true;
  return recipeAfter !== undefined && drawnRecipe(recipeAfter) !== drawnRecipe(recipeBefore);
}
