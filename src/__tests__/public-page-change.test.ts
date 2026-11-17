import { describe, expect, it } from 'vitest';

import {
  classifyPostPageChange,
  isPostListed,
  isPostPageDrawn,
  postPageStateOfRow,
  type PostPageState,
} from '@/lib/public-page-change';

const publicPost: PostPageState = { visibility: 'public', archived: false, hidden: false, isNsfw: false };
const unlistedPost: PostPageState = { ...publicPost, visibility: 'unlisted' };
const privatePost: PostPageState = { ...publicPost, visibility: 'private' };
const coveredPost: PostPageState = { ...publicPost, isNsfw: true };
const archivedPost: PostPageState = { ...publicPost, archived: true };
const heldPost: PostPageState = { ...publicPost, hidden: true };

describe('what a write to a post does to the cached public pages', () => {
  it('reads a post row as the pages see it', () => {
    expect(postPageStateOfRow({
      visibility: 'public',
      archived_at: null,
      review_status: 'visible',
      tombstoned_at: null,
      is_nsfw: false,
    })).toEqual(publicPost);
    expect(postPageStateOfRow({ visibility: 'public', archived_at: '2026-11-17T00:00:00Z' }).archived).toBe(true);
    expect(postPageStateOfRow({ visibility: 'public', review_status: 'hidden' }).hidden).toBe(true);
    expect(postPageStateOfRow({ visibility: 'public', tombstoned_at: '2026-11-17T00:00:00Z' }).hidden).toBe(true);
    // A row from before review statuses reads as visible, as the pages read it.
    expect(postPageStateOfRow({ visibility: 'public', review_status: null }).hidden).toBe(false);
  });

  it('draws a public or unlisted post on its page, and lists only a public one', () => {
    expect(isPostPageDrawn(publicPost)).toBe(true);
    expect(isPostPageDrawn(unlistedPost)).toBe(true);
    expect(isPostPageDrawn(privatePost)).toBe(false);
    expect(isPostPageDrawn(archivedPost)).toBe(false);
    expect(isPostPageDrawn(heldPost)).toBe(false);
    expect(isPostPageDrawn(null)).toBe(false);
    expect(isPostListed(publicPost)).toBe(true);
    expect(isPostListed(unlistedPost)).toBe(false);
  });

  it.each([
    ['public to private', publicPost, privatePost],
    ['unlisted to private', unlistedPost, privatePost],
    ['public to unlisted, out of the lists', publicPost, unlistedPost],
    ['covered as mature content', publicPost, coveredPost],
    ['an unlisted post covered as mature content', unlistedPost, { ...unlistedPost, isNsfw: true }],
  ])('takes %s as a removal: every page expires at once', (_name, before, after) => {
    expect(classifyPostPageChange(before, after)).toEqual({ kind: 'removal' });
  });

  // Review, 2026-11-17: a service reads the post at its start and writes it
  // later, and another request may make it public in between, its pages drawn.
  // A write that leaves the post out of view is a removal whatever its read said.
  it.each([
    ['saved private, read as private', privatePost, privatePost],
    ['saved private, first saved private', null, privatePost],
    ['saved unlisted, read as unlisted', unlistedPost, unlistedPost],
    ['edited while archived', archivedPost, archivedPost],
    ['edited while held by moderation', heldPost, heldPost],
    ['edited while covered, read as covered', coveredPost, coveredPost],
    ['made public but covered', privatePost, coveredPost],
    ['first saved public but covered', null, coveredPost],
  ])('takes a post %s as a removal: it may have been shown since the read', (_name, before, after) => {
    expect(classifyPostPageChange(before, after)).toEqual({ kind: 'removal' });
  });

  it.each([
    ['an edit of a public post', publicPost, publicPost],
    ['unlisted to public, onto the lists', unlistedPost, publicPost],
    ['the mature cover taken off', coveredPost, publicPost],
  ])('takes %s as a change on a page already drawn', (_name, before, after) => {
    expect(classifyPostPageChange(before, after)).toEqual({ kind: 'change', arrived: false });
  });

  it.each([
    ['a post made public', null, publicPost],
    ['private to public', privatePost, publicPost],
    ['restored from the archive', archivedPost, publicPost],
    ['brought back by a moderator', heldPost, publicPost],
  ])('takes %s as a change that brings the post onto its page', (_name, before, after) => {
    expect(classifyPostPageChange(before, after)).toEqual({ kind: 'change', arrived: true });
  });
});
