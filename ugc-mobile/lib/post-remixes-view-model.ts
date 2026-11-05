import type { PostRemixesResponse, ShowcaseFeedItem } from './types';

/**
 * A post's remixes as the app lists them (owner, 2026-11-05: A's remix count
 * opens them): the posted ones, newest first, a page at a time
 * (`GET /api/showcase/posts/:id/remixes`). The count holds every finished
 * remix, posted or not, so the list can be shorter, and says so.
 */

export const POST_REMIXES_PAGE_SIZE = 24;

export function postRemixesQueryKey(postId: string, viewerUserId: string | null | undefined) {
  return ['post-remixes', postId, viewerUserId ?? 'visitor'] as const;
}

/** The pages read so far as one list, each remix once. */
export function postRemixesFromPages(pages: PostRemixesResponse[] | undefined): ShowcaseFeedItem[] {
  const seen = new Set<string>();
  const items: ShowcaseFeedItem[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

/** Where the next page starts, or undefined at the end. */
export function nextPostRemixesOffset(page: PostRemixesResponse): number | undefined {
  return page.pageInfo?.hasMore && typeof page.pageInfo.nextOffset === 'number' ? page.pageInfo.nextOffset : undefined;
}

/** The screen's heading under its bar's "Remixes". */
export const POST_REMIXES_TITLE = 'Made from this post';
export const POST_REMIXES_SUBTITLE = 'Remixes their creators posted, newest first.';
/** The count that opened the list holds unposted remixes too, so the empty list never says there are none. */
export const POST_REMIXES_EMPTY_TITLE = 'No posted remixes yet';
export const POST_REMIXES_EMPTY = 'No remixes are posted yet. They show here once their creators post them.';
export const POST_REMIXES_UNPOSTED_NOTE = 'Some remixes haven’t been posted.';

/** Whether the list is complete and shorter than the count, because some remixes were never posted. */
export function hasUnpostedRemixes(listed: number, remixCount: number, hasMore: boolean): boolean {
  return !hasMore && listed < remixCount;
}

/** A remix's picture on its row: its cover's still, or none (a written post, one under its mature cover). */
export function postRemixThumbnailUrl(item: Pick<ShowcaseFeedItem, 'mediaItems' | 'mediaKind' | 'mediaUrl'>): string | null {
  const cover = item.mediaItems?.[0];
  return cover?.previewUrl ?? (item.mediaKind === 'image' ? item.mediaUrl : null);
}

/** "Sunset, again, by @maya": a row as a screen reader reads it. */
export function postRemixRowLabel(item: Pick<ShowcaseFeedItem, 'title' | 'creator'>): string {
  const creator = item.creator.username ? `@${item.creator.username}` : item.creator.name;
  return `${item.title}, by ${creator}`;
}
