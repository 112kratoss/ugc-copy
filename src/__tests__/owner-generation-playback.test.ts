import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/account-identity', () => ({ resolveLinkedAccountIds: async () => ['owner'] }));
const sign = vi.hoisted(() => vi.fn());
vi.mock('@/lib/owned-media-url-batch', () => ({ resolveOwnedStoredMediaUrlMap: sign }));
import { listOwnerGenerationsForRoute } from '@/lib/owner-generations-route-service';
const source = 'generated_videos/owner/original.mp4';
const derivative = 'generated_videos/owner/playback/generation/abc123.mp4';
describe('owner generation playback descriptors', () => {
  it.each([
    ['ready', source, derivative, '/api/media?bucket=generated_videos&path=owner%2Fplayback%2Fgeneration%2Fabc123.mp4'],
    ['failed', source, derivative, null],
    ['processing', source, derivative, null],
    ['ready', 'generated_videos/owner/older.mp4', derivative, null],
    ['ready', source, 'generated_videos/other/playback/generation/abc123.mp4', null],
  ])(
    'exposes only a ready current-source owner rendition, through the authenticated media route (%s, %s, %s)',
    async (status, original, path, expected) => {
      const row = {
        id: 'generation',
        user_id: 'owner',
        category: 'video',
        model: 'fixture',
        status: 'succeeded',
        created_at: '2026-09-06',
        output_url: source,
        playback_rendition_status: status,
        playback_rendition_source: original,
        playback_rendition_path: path,
      };
      sign.mockImplementation(
        async ({ outputUrls }: { outputUrls: string[] }) =>
          new Map(
            outputUrls.map((p) => [
              p,
              p === source
                ? 'https://storage.test/original.mp4'
                : 'https://storage.test/playback.mp4',
            ]),
          ),
      );
      const client = {
        from: (table: string) => ({
          select: (columns: string) => {
            const data =
              table === 'generations'
                ? [
                    Object.fromEntries(
                      Object.entries(row).filter(([key]) =>
                        columns
                          .split(',')
                          .map((s) => s.trim())
                          .includes(key),
                      ),
                    ),
                  ]
                : [];
            const q = {
              in: () => q,
              or: () => q,
              is: () => q,
              order: () => q,
              range: () => q,
              then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data, error: null }).then(resolve),
            };
            return q;
          },
        }),
      };
      const response = await listOwnerGenerationsForRoute({
        userId: 'owner',
        supabase: client as never,
        getAdminSupabase: () => client as never,
        searchParams: new URLSearchParams('detail=summary'),
      });
      expect(response.generations[0].media).toMatchObject({
        url: 'https://storage.test/original.mp4',
        renditionUrl: expected,
      });
      expect(response.generations[0].output_url).toBe('https://storage.test/original.mp4');
      expect(
        Object.keys(response.generations[0]).some((k) => k.startsWith('playback_rendition_')),
      ).toBe(false);
      // The rendition is never signed here: the route signs per request, and the
      // stable URL is what lets the client cache and keep a playing source.
      const candidates = sign.mock.calls.at(-1)![0].outputUrls as string[];
      expect(candidates.includes(path)).toBe(false);
    },
  );
});
