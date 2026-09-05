import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/account-identity', () => ({ resolveLinkedAccountIds: async () => ['owner'] }));
vi.mock('@/lib/owned-media-url-batch', () => ({
  resolveOwnedStoredMediaUrlMap: async () => new Map([
    ['generated_images/owner/source.png', 'https://storage.example/source.png'],
    ['generated_images/owner/preview.webp', 'https://storage.example/preview.webp'],
  ]),
}));
import { listOwnerGenerationsForRoute, type OwnerGenerationsRouteClient } from '@/lib/owner-generations-route-service';

describe('owner library media dimensions', () => {
  it.each([
    [720, 405, 720, 405],
    [405, 720, 405, 720],
    [null, null, null, null],
    [720, null, null, null],
    [0, 405, null, null],
  ])('delivers a usable dimension pair from stored preview metadata (%s × %s)', async (width, height, expectedWidth, expectedHeight) => {
    const row = {
      id: 'generation', user_id: 'owner', category: 'image', model: 'image-model',
      status: 'succeeded', created_at: '2026-09-05T00:00:00Z',
      output_url: 'generated_images/owner/source.png',
      preview_url: 'generated_images/owner/preview.webp', preview_status: 'ready',
      preview_width: width, preview_height: height,
    };
    const client = {
      from: (table: string) => ({
        select: (columns: string) => {
          // Respect the actual database projection: returning an entire mocked
          // row hid that the route never requested the persisted dimensions.
          const data = table === 'generations'
            ? [Object.fromEntries(Object.entries(row).filter(([key]) => columns.split(',').map(c => c.trim()).includes(key)))]
            : [];
          const query = {
            in: () => query, or: () => query, is: () => query,
            order: () => query, range: () => query,
            then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
          };
          return query;
        },
      }),
    } as unknown as OwnerGenerationsRouteClient;
    const result = await listOwnerGenerationsForRoute({
      userId: 'owner', supabase: client, getAdminSupabase: () => client,
      searchParams: new URLSearchParams('detail=summary'),
    });
    expect(result.generations[0].media).toMatchObject({ width: expectedWidth, height: expectedHeight });
  });
});
