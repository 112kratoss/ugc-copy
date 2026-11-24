import { describe, expect, it } from 'vitest';

import {
  classifyPostPageChange,
  editChangesFeedText,
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

// A listed post's words are on every cached feed card: an edit of them is
// served stale by none of those caches (review of #918). Only an edit that
// provably leaves every drawn word as it was is refreshed in the background.
describe('whether an edit changes what a feed card draws', () => {
  const stored = {
    title: 'My product shot',
    description: null,
    prompt: 'a red bottle on sand',
    body: null,
    post_format: 'media',
    category: 'image',
    source_tool: null,
    source_tool_slug: null,
    remixes_allowed: true,
  };
  const recipe = { accessMode: 'paid', priceUsdCents: 300, summary: 'The full prompt', previewText: null, resources: { promptText: 'x' } };

  it('leaves a media-only edit, which restates every word, to the background', () => {
    expect(editChangesFeedText({
      before: stored,
      patch: { title: 'My product shot', category: 'image', remixes_allowed: true },
      recipeBefore: recipe,
      recipeAfter: { ...recipe },
    })).toBe(false);
  });

  it('leaves an edit that names no recipe to the background', () => {
    expect(editChangesFeedText({ before: stored, patch: { category: 'image' }, recipeBefore: recipe })).toBe(false);
  });

  it('takes a changed title as a change of what the card draws', () => {
    expect(editChangesFeedText({ before: stored, patch: { title: 'Call me on 98765 43210' } })).toBe(true);
  });

  it('takes a changed prompt as a change of what the card draws', () => {
    expect(editChangesFeedText({ before: stored, patch: { prompt: 'a blue bottle' } })).toBe(true);
  });

  it.each([
    ['its price', { ...recipe, priceUsdCents: 500 }],
    ['its access', { ...recipe, accessMode: 'free', priceUsdCents: null }],
    ['its removal', null],
  ])('takes a recipe changed in %s as a change of what the card draws', (_name, recipeAfter) => {
    expect(editChangesFeedText({ before: stored, patch: {}, recipeBefore: recipe, recipeAfter })).toBe(true);
  });

  it('takes a column it could not read before the save as changed', () => {
    const withoutRemixSwitch: Record<string, unknown> = { ...stored };
    delete withoutRemixSwitch.remixes_allowed;
    expect(editChangesFeedText({ before: withoutRemixSwitch, patch: { remixes_allowed: true } })).toBe(true);
  });
});
