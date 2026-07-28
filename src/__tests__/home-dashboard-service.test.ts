import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadHomeFeed,
  loadHomeWhatsNewModels,
  loadHomeWorkspaceGenerations,
} from '@/lib/home-dashboard-service';
import { getFeedChip } from '@/lib/post-feed-chips';

const listOwnerGenerationsForRoute = vi.hoisted(() => vi.fn());
const loadPublishedGenerationModelCatalog = vi.hoisted(() => vi.fn());
const getShowcaseFeedPage = vi.hoisted(() => vi.fn());
const createServiceClient = vi.hoisted(() => vi.fn(() => ({ from: vi.fn() })));

vi.mock('@/lib/owner-generations-route-service', () => ({
  listOwnerGenerationsForRoute,
}));

vi.mock('@/lib/generation-model-catalog-store', () => ({
  loadPublishedGenerationModelCatalog,
}));

vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedPage,
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient,
}));

vi.mock('@/lib/backend-logger', () => ({
  logBackendError: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadHomeWorkspaceGenerations', () => {
  it('requests a summary page and projects the rows', async () => {
    listOwnerGenerationsForRoute.mockResolvedValue({
      generations: [
        {
          id: 'gen-1',
          status: 'processing',
          created_at: '2026-07-21T10:00:00.000Z',
          model: 'kling-3.0',
          category: 'video',
        },
        { id: null, status: 'broken row' },
      ],
      pagination: { limit: 12, hasMore: false, nextCursor: null },
    });

    const views = await loadHomeWorkspaceGenerations({ userId: 'user-1' });

    expect(listOwnerGenerationsForRoute).toHaveBeenCalledTimes(1);
    const args = listOwnerGenerationsForRoute.mock.calls[0][0];
    expect(args.userId).toBe('user-1');
    expect(args.searchParams.get('detail')).toBe('summary');
    expect(args.searchParams.get('limit')).toBe('12');
    expect(args.searchParams.get('includeArchived')).toBeNull();

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: 'gen-1', status: 'processing', isActive: true });
  });

  it('degrades to an empty list when the query throws (E2E non-UUID id)', async () => {
    listOwnerGenerationsForRoute.mockRejectedValue(
      new Error('invalid input syntax for type uuid: "workflow-user"'),
    );

    await expect(loadHomeWorkspaceGenerations({ userId: 'workflow-user' })).resolves.toEqual([]);
  });
});

describe('loadHomeWhatsNewModels', () => {
  it('selects from the published catalog snapshot', async () => {
    loadPublishedGenerationModelCatalog.mockResolvedValue({
      catalog: {
        models: [
          { id: 'fresh', kind: 'image', displayName: 'Fresh', description: 'x', badge: 'New', sortOrder: 10 },
          { id: 'stale', kind: 'image', displayName: 'Stale', description: 'x', badge: null, sortOrder: 20 },
        ],
      },
    });

    const models = await loadHomeWhatsNewModels();

    expect(loadPublishedGenerationModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'web' }),
    );
    expect(models.map((model) => model.id)).toEqual(['fresh']);
  });

  it('degrades to an empty list when the catalog is unavailable', async () => {
    loadPublishedGenerationModelCatalog.mockRejectedValue(new Error('catalog offline'));

    await expect(loadHomeWhatsNewModels()).resolves.toEqual([]);
  });
});

describe('loadHomeFeed', () => {
  it('forwards the chip lanes with the viewer id', async () => {
    const feedPage = { items: [], availableTools: [], pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 0 } };
    getShowcaseFeedPage.mockResolvedValue(feedPage);

    const result = await loadHomeFeed({ viewerUserId: 'user-1', chip: getFeedChip('recent') });

    expect(result).toBe(feedPage);
    expect(getShowcaseFeedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'all',
        sort: 'recent',
        viewerUserId: 'user-1',
        offset: 0,
      }),
    );
  });

  it('returns null when the feed fails so the page can render a callout', async () => {
    getShowcaseFeedPage.mockRejectedValue(new Error('feed offline'));

    await expect(
      loadHomeFeed({ viewerUserId: 'user-1', chip: getFeedChip(undefined) }),
    ).resolves.toBeNull();
  });
});
