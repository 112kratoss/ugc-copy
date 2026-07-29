import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Read models for the admin Revenue area.
 *
 * Money crosses four rails: web credit purchases (`transactions`), mobile IAP
 * (`mobile_store_transactions`), marketplace asset sales (`marketplace_orders`),
 * and post resource bundles (`post_resource_bundle_orders`). They are reported
 * side by side rather than summed into one number — the currencies and
 * settlement semantics differ, and a single blended total would be misleading.
 *
 * IMPORTANT: the rails are not disjoint in the database. A mobile in-app
 * purchase writes BOTH a `mobile_store_transactions` row and a `transactions`
 * row, linked by `mobile_store_transactions.source_record_id`, with
 * `transactions.mobile_product_id` set on the credit ledger side. Counting
 * `transactions` wholesale therefore double-counts every mobile purchase, so
 * the web rail explicitly excludes rows carrying a `mobile_product_id`.
 */

export type AdminRevenueWindow = 7 | 30 | 90;

export type AdminRevenueCurrencyTotal = {
  currency: string;
  grossSubunits: number;
  succeededCount: number;
};

export type AdminRevenueRail = {
  key: 'razorpay-credits' | 'mobile-iap' | 'marketplace' | 'resource-bundles';
  label: string;
  succeededCount: number;
  pendingCount: number;
  failedCount: number;
  /**
   * Deliberately a per-currency breakdown rather than a single `grossSubunits`.
   * `post_resource_bundle_orders` already carries both INR and USD in
   * production, so one summed figure would add rupees to dollars and report a
   * number that means nothing.
   */
  totalsByCurrency: AdminRevenueCurrencyTotal[];
  creditsIssued: number | null;
};

export type AdminRevenueOrder = {
  id: string;
  rail: AdminRevenueRail['key'];
  status: string;
  amountSubunits: number | null;
  currency: string;
  userId: string | null;
  createdAt: string;
  reference: string | null;
};

export type AdminRevenueReport = {
  windowDays: AdminRevenueWindow;
  since: string;
  rails: AdminRevenueRail[];
  recentOrders: AdminRevenueOrder[];
  creatorPayouts: {
    walletCount: number;
    availableTokenSubunits: number;
    lifetimeEarnedTokenSubunits: number;
  };
};

const SUCCESS_STATUSES = new Set(['success', 'paid', 'completed', 'succeeded', 'active']);
const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'refunded', 'reversed', 'expired']);

function classify(status: string): 'succeeded' | 'failed' | 'pending' {
  const normalized = status.toLowerCase();
  if (SUCCESS_STATUSES.has(normalized)) return 'succeeded';
  if (FAILURE_STATUSES.has(normalized)) return 'failed';
  return 'pending';
}

function summarizeRail(
  key: AdminRevenueRail['key'],
  label: string,
  rows: Array<{
    status: string;
    amountSubunits: number | null;
    currency: string;
    credits?: number | null;
  }>,
): AdminRevenueRail {
  let succeededCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let creditsIssued = 0;
  let sawCredits = false;
  const byCurrency = new Map<string, AdminRevenueCurrencyTotal>();

  for (const row of rows) {
    const outcome = classify(row.status);
    if (outcome === 'succeeded') {
      succeededCount += 1;

      // Only settled money counts toward gross; pending intents routinely never
      // complete and would inflate the figure.
      const currency = row.currency || 'INR';
      const existing = byCurrency.get(currency)
        ?? { currency, grossSubunits: 0, succeededCount: 0 };
      existing.grossSubunits += row.amountSubunits ?? 0;
      existing.succeededCount += 1;
      byCurrency.set(currency, existing);

      if (typeof row.credits === 'number') {
        creditsIssued += row.credits;
        sawCredits = true;
      }
    } else if (outcome === 'failed') {
      failedCount += 1;
    } else {
      pendingCount += 1;
    }
  }

  return {
    key,
    label,
    succeededCount,
    pendingCount,
    failedCount,
    // Sorted largest-first so the dominant currency leads the card.
    totalsByCurrency: [...byCurrency.values()].sort(
      (left, right) => right.grossSubunits - left.grossSubunits,
    ),
    creditsIssued: sawCredits ? creditsIssued : null,
  };
}

export async function collectAdminRevenueReport(
  client: SupabaseClient,
  options: { windowDays?: AdminRevenueWindow; now?: Date } = {},
): Promise<AdminRevenueReport> {
  const windowDays = options.windowDays ?? 30;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const [
    creditTransactions,
    mobileTransactions,
    marketplaceOrders,
    bundleOrders,
    wallets,
  ] = await Promise.all([
    client
      .from('transactions')
      .select('id, user_id, status, amount, credits, created_at, razorpay_payment_id')
      // Mobile purchases also land here; they are reported on the mobile rail
      // from `mobile_store_transactions` instead. See the module comment.
      .is('mobile_product_id', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000),
    client
      .from('mobile_store_transactions')
      .select('id, user_id, status, amount_subunits, currency, credits, created_at, product_id')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000),
    client
      .from('marketplace_orders')
      .select('id, buyer_user_id, status, amount_subunits, currency, created_at, razorpay_payment_id')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000),
    client
      .from('post_resource_bundle_orders')
      .select('id, buyer_user_id, status, amount_subunits, currency, created_at, razorpay_payment_id')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000),
    client
      .from('creator_resource_wallets')
      .select('available_token_subunits, lifetime_earned_token_subunits')
      .limit(5000),
  ]);

  for (const result of [creditTransactions, mobileTransactions, marketplaceOrders, bundleOrders, wallets]) {
    if (result.error) throw result.error;
  }

  const creditRows = (creditTransactions.data ?? []) as Array<Record<string, unknown>>;
  const mobileRows = (mobileTransactions.data ?? []) as Array<Record<string, unknown>>;
  const marketplaceRows = (marketplaceOrders.data ?? []) as Array<Record<string, unknown>>;
  const bundleRows = (bundleOrders.data ?? []) as Array<Record<string, unknown>>;
  const walletRows = (wallets.data ?? []) as Array<Record<string, unknown>>;

  const rails: AdminRevenueRail[] = [
    summarizeRail('razorpay-credits', 'Credit purchases (web)', creditRows.map((row) => ({
      status: String(row.status ?? ''),
      amountSubunits: typeof row.amount === 'number' ? row.amount : null,
      // `transactions` has no currency column; web Razorpay billing is INR.
      currency: 'INR',
      credits: typeof row.credits === 'number' ? row.credits : null,
    }))),
    summarizeRail('mobile-iap', 'Mobile in-app purchases', mobileRows.map((row) => ({
      status: String(row.status ?? ''),
      amountSubunits: typeof row.amount_subunits === 'number' ? row.amount_subunits : null,
      currency: String(row.currency ?? 'INR'),
      credits: typeof row.credits === 'number' ? row.credits : null,
    }))),
    summarizeRail('marketplace', 'Marketplace assets', marketplaceRows.map((row) => ({
      status: String(row.status ?? ''),
      amountSubunits: typeof row.amount_subunits === 'number' ? row.amount_subunits : null,
      currency: String(row.currency ?? 'INR'),
    }))),
    summarizeRail('resource-bundles', 'Post resource bundles', bundleRows.map((row) => ({
      status: String(row.status ?? ''),
      amountSubunits: typeof row.amount_subunits === 'number' ? row.amount_subunits : null,
      currency: String(row.currency ?? 'INR'),
    }))),
  ];

  const recentOrders: AdminRevenueOrder[] = [
    ...creditRows.map((row) => ({
      id: String(row.id),
      rail: 'razorpay-credits' as const,
      status: String(row.status ?? ''),
      amountSubunits: typeof row.amount === 'number' ? row.amount : null,
      currency: 'INR',
      userId: (row.user_id as string | null) ?? null,
      createdAt: String(row.created_at ?? ''),
      reference: (row.razorpay_payment_id as string | null) ?? null,
    })),
    ...mobileRows.map((row) => ({
      id: String(row.id),
      rail: 'mobile-iap' as const,
      status: String(row.status ?? ''),
      amountSubunits: typeof row.amount_subunits === 'number' ? row.amount_subunits : null,
      currency: String(row.currency ?? 'USD'),
      userId: (row.user_id as string | null) ?? null,
      createdAt: String(row.created_at ?? ''),
      reference: (row.product_id as string | null) ?? null,
    })),
    ...marketplaceRows.map((row) => ({
      id: String(row.id),
      rail: 'marketplace' as const,
      status: String(row.status ?? ''),
      amountSubunits: typeof row.amount_subunits === 'number' ? row.amount_subunits : null,
      currency: String(row.currency ?? 'INR'),
      userId: (row.buyer_user_id as string | null) ?? null,
      createdAt: String(row.created_at ?? ''),
      reference: (row.razorpay_payment_id as string | null) ?? null,
    })),
    ...bundleRows.map((row) => ({
      id: String(row.id),
      rail: 'resource-bundles' as const,
      status: String(row.status ?? ''),
      amountSubunits: typeof row.amount_subunits === 'number' ? row.amount_subunits : null,
      currency: String(row.currency ?? 'INR'),
      userId: (row.buyer_user_id as string | null) ?? null,
      createdAt: String(row.created_at ?? ''),
      reference: (row.razorpay_payment_id as string | null) ?? null,
    })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 60);

  return {
    windowDays,
    since,
    rails,
    recentOrders,
    creatorPayouts: {
      walletCount: walletRows.length,
      availableTokenSubunits: walletRows.reduce(
        (total, row) => total + Number(row.available_token_subunits ?? 0),
        0,
      ),
      lifetimeEarnedTokenSubunits: walletRows.reduce(
        (total, row) => total + Number(row.lifetime_earned_token_subunits ?? 0),
        0,
      ),
    },
  };
}
