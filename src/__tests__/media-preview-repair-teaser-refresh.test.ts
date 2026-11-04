import { beforeEach, expect, it, vi } from 'vitest';

const teasers = vi.hoisted(() => ({ has: vi.fn(), repair: vi.fn() }));

vi.mock('@/lib/post-media-teaser-repair', () => ({
  hasRepairablePostMediaTeasers: teasers.has,
  repairPostMediaTeasers: teasers.repair,
}));

vi.mock('@/lib/generation-playback-rendition', () => ({
  hasPendingGenerationPlaybackRendition: vi.fn(async () => false),
  repairGenerationPlaybackRendition: vi.fn(async () => ({ attempted: 0, completed: 0, failed: 0 })),
}));

import { repairMediaPreviews } from '@/lib/media-preview-repair';

/** A database with nothing to repair but what the mocked teaser pass reports. */
function idleClient() {
  const query: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'in', 'is', 'or', 'lt', 'gt', 'not', 'order', 'limit', 'like']) {
    query[name] = () => query;
  }
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
  return { from: vi.fn(() => query), rpc: async () => ({ data: [], error: null }) };
}

beforeEach(() => {
  teasers.has.mockReset().mockResolvedValue(true);
  teasers.repair.mockReset();
});

it('refreshes the feed for a finished teaser, whose repair does not say which post it served', async () => {
  teasers.repair.mockResolvedValue({ attempted: 1, completed: 1, failed: 0 });
  const client = idleClient();
  const invalidateFeedCache = vi.fn();

  await repairMediaPreviews(client as never, { invalidateFeedCache });

  expect(invalidateFeedCache).toHaveBeenCalledOnce();
  // Nothing to look up: a teaser counts without a read.
  expect(client.from).not.toHaveBeenCalledWith('posts');
});

it('leaves the feed alone when the teaser pass finishes nothing', async () => {
  teasers.repair.mockResolvedValue({ attempted: 1, completed: 0, failed: 1 });
  const invalidateFeedCache = vi.fn();

  await repairMediaPreviews(idleClient() as never, { invalidateFeedCache });

  expect(invalidateFeedCache).not.toHaveBeenCalled();
});
