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
