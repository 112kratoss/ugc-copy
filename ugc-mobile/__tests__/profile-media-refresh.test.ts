import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  INITIAL_PROFILE_REVALIDATION_GATE,
  PROFILE_GENERATION_PAGES,
  PROFILE_OWNER_POST_PAGES,
  PROFILE_REVALIDATION_COOLDOWN_MS,
  PROFILE_REVALIDATION_MAX_DELAY_MS,
  PROFILE_SAVED_MEDIA_PAGES,
  canRevalidateProfileMedia,
  mergeRefreshedFirstPage,
  profileRevalidationDelayMs,
  recordProfileRevalidationFailure,
  recordProfileRevalidationStart,
  recordProfileRevalidationSuccess,
} from '../lib/profile-media-refresh';
import type { GenerationListItem, GenerationListResponse, OwnerPostListItem, OwnerPostsResponse, ShowcaseFeedItem, ShowcaseFeedResponse } from '../lib/types';
import { flattenProfileOwnerPostPages, getNextProfileOwnerPostsOffset, getNextProfileSavedMediaOffset } from '../lib/profile-media-query';

function generation(id: string, minute: number): GenerationListItem {
  return {
    id,
    output_url: `https://cdn.example.com/${id}.png`,
    status: 'succeeded',
    created_at: new Date(Date.UTC(2026, 8, 16, 10, minute)).toISOString(),
    model: 'nano-banana-2',
    category: 'image',
  };
}

function page(items: GenerationListItem[], hasMore: boolean): GenerationListResponse {
  return { generations: items, pagination: { limit: 3, hasMore, nextCursor: hasMore ? 'next' : null } };
}

function library(...pages: GenerationListResponse[]): InfiniteData<GenerationListResponse, string | null> {
  return { pages, pageParams: pages.map((_, index) => (index === 0 ? null : String(index * 3))) };
}

function ids(data: InfiniteData<GenerationListResponse, string | null>) {
  return data.pages.flatMap((entry) => entry.generations.map((item) => item.id));
}

describe('profile library revalidation gate', () => {
  const stale = { isFetching: false, isStale: true };

  it('lets the first qualifying event refresh stale data', () => {
    expect(canRevalidateProfileMedia({ gate: INITIAL_PROFILE_REVALIDATION_GATE, now: 0, ...stale })).toBe(true);
  });

  it('never refreshes fresh data, or data already on the wire', () => {
    const gate = INITIAL_PROFILE_REVALIDATION_GATE;
    expect(canRevalidateProfileMedia({ gate, now: 0, isFetching: false, isStale: false })).toBe(false);
    expect(canRevalidateProfileMedia({ gate, now: 0, isFetching: true, isStale: true })).toBe(false);
  });

  it('spaces attempts by the cooldown and doubles it per consecutive failure, up to a ceiling', () => {
    let gate = recordProfileRevalidationStart(INITIAL_PROFILE_REVALIDATION_GATE, 0);
    expect(canRevalidateProfileMedia({ gate, now: PROFILE_REVALIDATION_COOLDOWN_MS - 1, ...stale })).toBe(false);
    expect(canRevalidateProfileMedia({ gate, now: PROFILE_REVALIDATION_COOLDOWN_MS, ...stale })).toBe(true);

    gate = recordProfileRevalidationFailure(gate, { status: 500 }, 0);
    expect(canRevalidateProfileMedia({ gate, now: PROFILE_REVALIDATION_COOLDOWN_MS, ...stale })).toBe(false);
    expect(canRevalidateProfileMedia({ gate, now: PROFILE_REVALIDATION_COOLDOWN_MS * 2, ...stale })).toBe(true);

    expect(profileRevalidationDelayMs(3)).toBe(PROFILE_REVALIDATION_COOLDOWN_MS * 8);
    expect(profileRevalidationDelayMs(40)).toBe(PROFILE_REVALIDATION_MAX_DELAY_MS);
  });

  it('keeps a rate-limited library quiet until the server says it may ask again', () => {
    const started = recordProfileRevalidationStart(INITIAL_PROFILE_REVALIDATION_GATE, 0);
    const limited = recordProfileRevalidationFailure(started, { status: 429, details: { retryAfterSeconds: 300 } }, 0);

    expect(canRevalidateProfileMedia({ gate: limited, now: 299_999, ...stale })).toBe(false);
    expect(canRevalidateProfileMedia({ gate: limited, now: 300_000, ...stale })).toBe(true);
  });

  it('forgets earlier failures once a refresh succeeds', () => {
    const failed = recordProfileRevalidationFailure(
      recordProfileRevalidationStart(INITIAL_PROFILE_REVALIDATION_GATE, 0),
      { status: 429 },
      0
    );
    const recovered = recordProfileRevalidationSuccess(failed);

    expect(recovered).toMatchObject({ failures: 0, notBeforeAt: null, lastAttemptAt: 0 });
  });
});

describe('mergeRefreshedFirstPage', () => {
  it.each(['delete', 'insert', 'filtered'] as const)('continues owner posts without gaps after a head %s', (change) => {
    const rows = Array.from({ length: 72 }, (_, index) => ({
      id: String(index + 1), createdAt: new Date(Date.UTC(2026, 8, 16, 0, 72 - index)).toISOString(),
    } as OwnerPostListItem));
    const read = (data: OwnerPostListItem[], offset: number): OwnerPostsResponse => ({
      success: true,
      posts: data.slice(offset, offset + 24).filter((row) => change !== 'filtered' || Number(row.id) % 2 === 1),
      pageInfo: { hasMore: offset + 24 < data.length, nextOffset: offset + 24 < data.length ? offset + 24 : null },
    } as OwnerPostsResponse);
    const cache = { pages: [read(rows, 0), read(rows, 24)], pageParams: [0, 24] };
    const changed = change === 'insert'
      ? [{ ...rows[0], id: 'new', createdAt: '2026-09-17T00:00:00.000Z' }, ...rows]
      : rows.slice(1);
    const merged = mergeRefreshedFirstPage(cache, read(changed, 0), 0, PROFILE_OWNER_POST_PAGES);
    // The UI retains its loaded tail while future reads restart at the head's
    // current server boundary, including rows filtered out of the response.
    expect(flattenProfileOwnerPostPages(merged.pages).some((row) => row.id === '47')).toBe(true);
    let next = getNextProfileOwnerPostsOffset(merged.pages.at(-1)!);
    for (let guard = 0; next !== undefined && guard < 10; guard += 1) {
      merged.pages.push(read(changed, next));
      next = getNextProfileOwnerPostsOffset(merged.pages.at(-1)!);
    }
    const actual = flattenProfileOwnerPostPages(merged.pages).map((row) => row.id);
    const expected = changed.filter((row) => change !== 'filtered' || Number(row.id) % 2 === 1).map((row) => row.id);
    expect(actual).toEqual(expected);
  });

  it('reopens saved continuation after a head refresh even if the old tail was exhausted', () => {
    const saved = (id: string) => ({ id, isSaved: true }) as ShowcaseFeedItem;
    const makePage = (items: string[], nextOffset: number | null) => ({
      items: items.map(saved), pageInfo: { hasMore: nextOffset !== null, nextOffset },
    } as ShowcaseFeedResponse);
    const current = { pages: [makePage(['a', 'b'], 2), makePage(['c', 'd'], null)], pageParams: [0, 2] };
    const merged = mergeRefreshedFirstPage(current, makePage(['new', 'a'], 2), 0, PROFILE_SAVED_MEDIA_PAGES);
    expect(getNextProfileSavedMediaOffset(merged.pages.at(-1)!)).toBe(2);
    expect(merged.pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(['new', 'a', 'b', 'c', 'd']);
  });

  it('keeps saved media on its own continuation when the head comes back unchanged', () => {
    const saved = (id: string) => ({ id, isSaved: true }) as ShowcaseFeedItem;
    const makePage = (items: string[], nextOffset: number | null) => ({
      items: items.map(saved), pageInfo: { hasMore: nextOffset !== null, nextOffset },
    } as ShowcaseFeedResponse);
    const current = { pages: [makePage(['a', 'b'], 2), makePage(['c', 'd'], null)], pageParams: [0, 2] };
    // Nothing ahead of the reader moved, so reopening the exhausted tail would
    // re-read pages they already hold — the cost this merge exists to avoid.
    const merged = mergeRefreshedFirstPage(current, makePage(['a', 'b'], 2), 0, PROFILE_SAVED_MEDIA_PAGES);
    expect(getNextProfileSavedMediaOffset(merged.pages.at(-1)!)).toBeUndefined();
  });

  it('leaves an unchanged owner-post head paging from where the reader stopped', () => {
    const post = (id: string) => ({ id, createdAt: `2026-09-16T00:${id.padStart(2, '0')}:00.000Z` } as OwnerPostListItem);
    const makePage = (ids: string[], nextOffset: number | null): OwnerPostsResponse => ({
      success: true,
      posts: ids.map(post),
      pageInfo: { hasMore: nextOffset !== null, nextOffset },
    } as OwnerPostsResponse);
    const current = { pages: [makePage(['3', '2'], 2), makePage(['1'], 3)], pageParams: [0, 2] };
    const merged = mergeRefreshedFirstPage(current, makePage(['3', '2'], 2), 0, PROFILE_OWNER_POST_PAGES);
    expect(getNextProfileOwnerPostsOffset(merged.pages.at(-1)!)).toBe(3);
  });

  it('replaces only the first page and keeps every page the reader loaded', () => {
    const current = library(
      page([generation('g10', 10), generation('g9', 9), generation('g8', 8)], true),
      page([generation('g7', 7), generation('g6', 6), generation('g5', 5)], true),
      page([generation('g4', 4)], false)
    );
    const fresh = page([generation('g10', 10), generation('g9', 9), generation('g8', 8)], true);

    const merged = mergeRefreshedFirstPage(current, fresh, null, PROFILE_GENERATION_PAGES);

    expect(merged.pages[0]).toBe(fresh);
    expect(ids(merged)).toEqual(['g10', 'g9', 'g8', 'g7', 'g6', 'g5', 'g4']);
    expect(merged.pageParams).toEqual(current.pageParams);
  });

  it('keeps creations that new work pushed down, instead of losing them between pages', () => {
    const current = library(
      page([generation('g10', 10), generation('g9', 9), generation('g8', 8)], true),
      page([generation('g7', 7), generation('g6', 6), generation('g5', 5)], true)
    );
    const fresh = page([generation('n12', 12), generation('n11', 11), generation('g10', 10)], true);

    expect(ids(mergeRefreshedFirstPage(current, fresh, null, PROFILE_GENERATION_PAGES)))
      .toEqual(['n12', 'n11', 'g10', 'g9', 'g8', 'g7', 'g6', 'g5']);
  });

  it('drops a creation that vanished from inside the fresh page\'s range, and never duplicates one', () => {
    const current = library(
      page([generation('g10', 10), generation('g9', 9), generation('g8', 8)], true),
      page([generation('g7', 7), generation('g6', 6), generation('g5', 5)], true)
    );
    // g9 was archived elsewhere; g7 moved up into the first page.
    const fresh = page([generation('g10', 10), generation('g8', 8), generation('g7', 7)], true);

    expect(ids(mergeRefreshedFirstPage(current, fresh, null, PROFILE_GENERATION_PAGES)))
      .toEqual(['g10', 'g8', 'g7', 'g6', 'g5']);
  });

  it('treats a fresh page with nothing more after it as the whole library', () => {
    const current = library(
      page([generation('g3', 3), generation('g2', 2), generation('g1', 1)], true),
      page([generation('g0', 0)], false)
    );
    const fresh = page([generation('g3', 3), generation('g1', 1)], false);

    const merged = mergeRefreshedFirstPage(current, fresh, null, PROFILE_GENERATION_PAGES);
    expect(merged).toEqual({ pages: [fresh], pageParams: [null] });
  });

  it('starts a library that had nothing loaded from the fresh page', () => {
    const fresh = page([generation('g1', 1)], true);
    expect(mergeRefreshedFirstPage(undefined, fresh, null, PROFILE_GENERATION_PAGES))
      .toEqual({ pages: [fresh], pageParams: [null] });
  });

  it('keeps displaced saved items, which carry no order key to judge them by', () => {
    const saved = (id: string) => ({ id, isSaved: true }) as ShowcaseFeedItem;
    const savedPage = (items: ShowcaseFeedItem[], hasMore: boolean): ShowcaseFeedResponse => ({
      items,
      pageInfo: { hasMore, limit: 2, offset: 0, nextLimit: null, nextOffset: hasMore ? 2 : null },
    } as ShowcaseFeedResponse);
    const current = { pages: [savedPage([saved('a'), saved('b')], true), savedPage([saved('c')], false)], pageParams: [0, 2] };

    const merged = mergeRefreshedFirstPage(current, savedPage([saved('new'), saved('a')], true), 0, PROFILE_SAVED_MEDIA_PAGES);

    expect(merged.pages.flatMap((entry) => entry.items.map((item) => item.id))).toEqual(['new', 'a', 'b', 'c']);
  });
});
