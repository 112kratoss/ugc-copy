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
    expect(isPostPageDrawn({ ...publicPost, archived: true })).toBe(false);
    expect(isPostPageDrawn({ ...publicPost, hidden: true })).toBe(false);
    expect(isPostPageDrawn(null)).toBe(false);
    expect(isPostListed(publicPost)).toBe(true);
    expect(isPostListed(unlistedPost)).toBe(false);
  });

  it.each([
    ['public to private', publicPost, privatePost],
    ['unlisted to private', unlistedPost, privatePost],
    ['public to unlisted, out of the lists', publicPost, unlistedPost],
    ['covered as mature content', publicPost, { ...publicPost, isNsfw: true }],
    ['an unlisted post covered as mature content', unlistedPost, { ...unlistedPost, isNsfw: true }],
  ])('takes %s as a removal: every page expires at once', (_name, before, after) => {
    expect(classifyPostPageChange(before, after)).toEqual({ kind: 'removal' });
  });

  it.each([
    ['an edit of a public post', publicPost, publicPost],
    ['an edit of an unlisted post', unlistedPost, unlistedPost],
    ['unlisted to public, onto the lists', unlistedPost, publicPost],
    ['the mature cover taken off', { ...publicPost, isNsfw: true }, publicPost],
    ['an edit of a private post', privatePost, privatePost],
    ['an edit of an archived post', { ...publicPost, archived: true }, { ...publicPost, archived: true }],
  ])('takes %s as a change on a page already drawn', (_name, before, after) => {
    expect(classifyPostPageChange(before, after)).toEqual({
      kind: 'change',
      arrived: false,
    });
  });

  it.each([
    ['a post made public', null, publicPost],
    ['a post made unlisted', null, unlistedPost],
    ['a post made as mature content', null, { ...publicPost, isNsfw: true }],
    ['private to public', privatePost, publicPost],
    ['private to unlisted', privatePost, unlistedPost],
    ['restored from the archive', { ...publicPost, archived: true }, publicPost],
    ['brought back by a moderator', { ...publicPost, hidden: true }, publicPost],
  ])('takes %s as a change that brings the post onto its page', (_name, before, after) => {
    expect(classifyPostPageChange(before, after)).toEqual({ kind: 'change', arrived: true });
  });

  it('never calls a post saved private, or kept off its page, an arrival', () => {
    expect(classifyPostPageChange(null, privatePost)).toEqual({ kind: 'change', arrived: false });
    expect(classifyPostPageChange({ ...publicPost, hidden: true }, { ...publicPost, hidden: true }))
      .toEqual({ kind: 'change', arrived: false });
  });
});
