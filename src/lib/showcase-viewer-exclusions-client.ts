import { SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS } from '@/lib/showcase';

/**
 * What the viewer's own feed leaves out among the posts a page has drawn
 * (`showcase-viewer-exclusions-service.ts`): creators with a block between them
 * and the viewer, and the viewer's own Hide and Not interested.
 */
export type ShowcaseViewerExclusions = {
  blockedCreatorIds: string[];
  hiddenCreatorIds: string[];
  hiddenPostIds: string[];
};

function readIds(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : null;
}

/**
 * Asks the server about the posts on screen. `null` when it could not be
 * asked or did not answer: the page then keeps what it drew, which is what it
 * did before there was anything to ask.
 */
export async function fetchShowcaseViewerExclusions({
  items,
  accessToken,
  signal,
}: {
  items: Array<{ id: string; creator: { id?: string | null } }>;
  accessToken: string;
  signal?: AbortSignal;
}): Promise<ShowcaseViewerExclusions | null> {
  if (items.length === 0) return null;

  try {
    const response = await fetch('/api/showcase/viewer-exclusions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: items.slice(0, SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS).map((item) => ({
          postId: item.id,
          creatorId: item.creator.id ?? null,
        })),
      }),
      signal,
    });
    if (!response.ok) return null;

    const body = await response.json() as Partial<Record<keyof ShowcaseViewerExclusions, unknown>> | null;
    const blockedCreatorIds = readIds(body?.blockedCreatorIds);
    const hiddenCreatorIds = readIds(body?.hiddenCreatorIds);
    const hiddenPostIds = readIds(body?.hiddenPostIds);
    return blockedCreatorIds && hiddenCreatorIds && hiddenPostIds
      ? { blockedCreatorIds, hiddenCreatorIds, hiddenPostIds }
      : null;
  } catch {
    return null;
  }
}
