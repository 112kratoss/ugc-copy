import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const collectBackendOpsDashboard = vi.fn();

vi.mock('@/lib/backend-ops-dashboard', () => ({
  collectBackendOpsDashboard: (...args: unknown[]) => collectBackendOpsDashboard(...args),
}));

const { collectAdminOverview } = await import('@/lib/admin-overview-service');

/**
 * `countSince` and the inline counters both terminate in a thenable
 * `{ count, error }`. One builder shape serves every table; the per-table count
 * comes from the map below so a mixed-up wiring shows as a wrong number rather
 * than a passing test.
 */
function makeClient(options: {
  counts: Record<string, number>;
  population?: Record<string, number>;
  populationError?: { message: string } | null;
}) {
  const rpc = vi.fn(async () => ({
    data: options.population ?? null,
    error: options.populationError ?? null,
  }));

  const from = vi.fn((table: string) => {
    const result = { count: options.counts[table] ?? 0, error: null };
    const builder: Record<string, unknown> = {
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    for (const method of ['select', 'gte', 'eq', 'in']) {
      builder[method] = vi.fn(() => builder);
    }
    return builder;
  });

  return { rpc, from } as unknown as SupabaseClient & { rpc: typeof rpc; from: typeof from };
}

describe('collectAdminOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collectBackendOpsDashboard.mockResolvedValue({ panels: [] });
  });

  it('counts registered accounts, not profile rows', async () => {
    // The regression: `profiles` holds one row per auth identity and most are
    // anonymous guests, so the Overview read 93 users / 33 new against a true
    // 28 / 2. The counters must come from the population RPC, never from a
    // count over `profiles`.
    const client = makeClient({
      counts: { posts: 12, generations: 3, post_reports: 1, moderation_reports: 0, transactions: 6 },
      population: { registered_total: 28, registered_since: 2, guest_total: 65, guest_since: 31 },
    });

    const overview = await collectAdminOverview(client);

    expect(overview.counters.totalUsers).toBe(28);
    expect(overview.counters.newUsers7d).toBe(2);
    expect(client.from).not.toHaveBeenCalledWith('profiles');
  });

  it('surfaces guest sessions instead of discarding them', async () => {
    // Guests are real load and real storage. Dropping them would replace one
    // misleading number with another.
    const client = makeClient({
      counts: {},
      population: { registered_total: 28, registered_since: 2, guest_total: 65, guest_since: 31 },
    });

    const overview = await collectAdminOverview(client);

    expect(overview.counters.guestSessions).toBe(65);
    expect(overview.counters.newGuestSessions7d).toBe(31);
  });

  it('asks the RPC for the same 7-day window the card advertises', async () => {
    const client = makeClient({ counts: {}, population: { registered_total: 1 } });
    const now = new Date('2026-08-25T00:00:00.000Z');

    await collectAdminOverview(client, { now });

    expect(client.rpc).toHaveBeenCalledWith('admin_user_population_counts', {
      p_since: '2026-08-18T00:00:00.000Z',
    });
  });

  it('reports zero rather than NaN when the RPC returns nothing', async () => {
    const client = makeClient({ counts: {}, population: undefined });

    const overview = await collectAdminOverview(client);

    expect(overview.counters.totalUsers).toBe(0);
    expect(overview.counters.guestSessions).toBe(0);
  });

  it('fails loudly when the population lookup errors', async () => {
    // A silently-zeroed user count reads as "we lost every account", which is
    // worse than an error surface.
    const client = makeClient({
      counts: {},
      population: undefined,
      populationError: { message: 'permission denied' },
    });

    await expect(collectAdminOverview(client)).rejects.toMatchObject({ message: 'permission denied' });
  });

  it('keeps the counters when the health dashboard collector fails', async () => {
    // Pre-existing contract: one failing panel degrades that panel, not the
    // numbers beside it.
    collectBackendOpsDashboard.mockRejectedValue(new Error('collector down'));
    const client = makeClient({
      counts: { posts: 12 },
      population: { registered_total: 28, registered_since: 2, guest_total: 65, guest_since: 31 },
    });

    const overview = await collectAdminOverview(client);

    expect(overview.dashboard).toBeNull();
    expect(overview.dashboardError).toBe('collector down');
    expect(overview.counters.totalUsers).toBe(28);
  });
});
