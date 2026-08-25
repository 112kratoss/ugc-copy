import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { collectBackendOpsDashboard, type BackendOpsDashboard } from '@/lib/backend-ops-dashboard';

/**
 * The admin Overview reuses the existing `/api/ops/backend-dashboard` collector
 * rather than re-deriving health. Those thresholds are already unit-tested and
 * drive the external watchdog, so a second implementation here would be a
 * second source of truth that could disagree with the alert that pages someone.
 */

export type AdminOverviewCounters = {
  /**
   * Registered accounts only. `profiles` holds one row per auth identity, and
   * most of those are anonymous guests — the app mints one on first launch, and
   * a reinstall mints another — so counting the table wholesale reported 93
   * users against a true 28. Guests are surfaced separately rather than dropped.
   */
  totalUsers: number;
  newUsers7d: number;
  guestSessions: number;
  newGuestSessions7d: number;
  totalPosts: number;
  newPosts7d: number;
  generations24h: number;
  failedGenerations24h: number;
  openModerationReports: number;
  paidOrders30d: number;
};

export type AdminOverview = {
  dashboard: BackendOpsDashboard | null;
  dashboardError: string | null;
  counters: AdminOverviewCounters;
};

async function countSince(
  client: SupabaseClient,
  table: string,
  column: string | null,
  since: string | null,
): Promise<number> {
  let query = client.from(table).select('id', { count: 'exact', head: true });
  if (column && since) {
    query = query.gte(column, since);
  }
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export async function collectAdminOverview(
  client: SupabaseClient,
  options: { now?: Date } = {},
): Promise<AdminOverview> {
  const now = options.now ?? new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    dashboardResult,
    population,
    totalPosts,
    newPosts7d,
    generations24h,
    failedGenerations24h,
    openPostReports,
    openSubjectReports,
    paidOrders30d,
  ] = await Promise.all([
    // The dashboard aggregates several collectors; a failure in one should
    // degrade the panel, not blank out the counters beside it.
    collectBackendOpsDashboard(client, { now }).then(
      (dashboard) => ({ dashboard, error: null as string | null }),
      (error: unknown) => ({
        dashboard: null,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    // `is_anonymous` lives on auth.users, which PostgREST does not expose, so
    // the registered/guest split comes from a SECURITY DEFINER function rather
    // than a count over `profiles`.
    client.rpc('admin_user_population_counts', { p_since: weekAgo }),
    countSince(client, 'posts', null, null),
    countSince(client, 'posts', 'created_at', weekAgo),
    countSince(client, 'generations', 'created_at', dayAgo),
    client
      .from('generations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('created_at', dayAgo),
    client.from('post_reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    client
      .from('moderation_reports')
      .select('id', { count: 'exact', head: true })
      .in('status', ['open', 'reviewing']),
    client
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'success')
      // Dev-era test-mode purchases charged 1–5 rupees for a full credit pack;
      // counting them here would report eight paid orders against one real sale.
      .eq('is_test', false)
      .gte('created_at', monthAgo),
  ]);

  for (const result of [population, failedGenerations24h, openPostReports, openSubjectReports, paidOrders30d]) {
    if (result.error) throw result.error;
  }

  const populationCounts = (population.data ?? {}) as Record<string, number | undefined>;

  return {
    dashboard: dashboardResult.dashboard,
    dashboardError: dashboardResult.error,
    counters: {
      totalUsers: populationCounts.registered_total ?? 0,
      newUsers7d: populationCounts.registered_since ?? 0,
      guestSessions: populationCounts.guest_total ?? 0,
      newGuestSessions7d: populationCounts.guest_since ?? 0,
      totalPosts,
      newPosts7d,
      generations24h,
      failedGenerations24h: failedGenerations24h.count ?? 0,
      openModerationReports: (openPostReports.count ?? 0) + (openSubjectReports.count ?? 0),
      paidOrders30d: paidOrders30d.count ?? 0,
    },
  };
}
