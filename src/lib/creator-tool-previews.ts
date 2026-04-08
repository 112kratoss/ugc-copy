import type { CreatorToolId } from '@/lib/creator-tools';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import type { ShowcaseFeedItem } from '@/lib/showcase';

export type CreatorToolPreviewMap = Record<CreatorToolId, ShowcaseFeedItem | null>;

export function buildCreatorToolPreviewMap(items: ShowcaseFeedItem[]): CreatorToolPreviewMap {
  const mediaFeedItems = items.filter((item) => item.mediaUrl);

  return {
    image: mediaFeedItems.find((item) => item.category === 'image') ?? null,
    video: mediaFeedItems.find((item) => item.category === 'video') ?? null,
    motion: mediaFeedItems.find((item) => item.category === 'motion') ?? null,
    workflow: null,
  };
}

export async function loadCreatorToolPreviewMap(options?: {
  viewerUserId?: string | null;
  seedItems?: ShowcaseFeedItem[];
}): Promise<CreatorToolPreviewMap> {
  const viewerUserId = options?.viewerUserId ?? null;
  const previewByTool = buildCreatorToolPreviewMap(options?.seedItems ?? []);
  const missingToolIds = (['image', 'video', 'motion'] as const).filter(
    (toolId) => !previewByTool[toolId]
  );

  if (missingToolIds.length === 0) {
    return previewByTool;
  }

  const fallbackFeeds = await Promise.all(
    missingToolIds.map(async (toolId) => {
      const feed = await getShowcaseFeedPage({
        category: toolId,
        sort: 'top-saves',
        offset: 0,
        limit: 1,
        viewerUserId,
      });

      return { toolId, item: feed.items.find((item) => item.mediaUrl) ?? null };
    })
  );

  for (const { toolId, item } of fallbackFeeds) {
    previewByTool[toolId] = item;
  }

  return previewByTool;
}
