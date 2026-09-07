import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ pending: vi.fn(), repair: vi.fn() }));
vi.mock('@/lib/generation-playback-rendition', () => ({
  hasPendingGenerationPlaybackRendition: mocks.pending,
  repairGenerationPlaybackRendition: mocks.repair,
}));
import { hasRepairableMediaPreviews, repairMediaPreviews } from '@/lib/media-preview-repair';
beforeEach(() => {
  mocks.pending.mockReset().mockResolvedValue(true);
  mocks.repair.mockReset().mockResolvedValue({ attempted: 1, completed: 1, failed: 0 });
});
function emptyClient() {
  const q: Record<string, unknown> = {};
  for (const name of [
    'select',
    'eq',
    'in',
    'is',
    'or',
    'lt',
    'gt',
    'not',
    'order',
    'limit',
    'like',
  ])
    q[name] = () => q;
  q.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  return { from: () => q, rpc: async () => ({ data: [], error: null }) };
}
it('admits a private rendition even when all preview/post work has drained', async () => {
  const client = emptyClient();
  expect(await hasRepairableMediaPreviews(client as never)).toBe(true);
  expect(await repairMediaPreviews(client as never, { invalidateFeedCache: vi.fn() })).toEqual({
    attempted: 1,
    completed: 1,
    failed: 0,
  });
  expect(mocks.repair).toHaveBeenCalledExactlyOnceWith(client);
});
it('does not start an encode after idle probes have already consumed its headroom', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(30_000);
  try {
    expect(
      await repairMediaPreviews(emptyClient() as never, { invalidateFeedCache: vi.fn() }),
    ).toEqual({ attempted: 0, completed: 0, failed: 0 });
    expect(mocks.repair).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});
