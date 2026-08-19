import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A single "who did what" feed across every operator action.
 *
 * Each action type already records its own audit row, but each was only ever
 * readable from the page that produced it — credit adjustments only from one
 * user's detail page, sanctions likewise. There was no way to answer "what did
 * we do today?", which is the question asked after a mistake, during a
 * handover, or when reconciling a disputed decision.
 *
 * The four sources are separate tables with no shared key, so they are merged
 * in memory and paged from the merged list, the same way the revenue rails are.
 * `PER_SOURCE_LIMIT` bounds each fetch; `truncated` reports when a source hit
 * it, because a quietly capped audit log is worse than none.
 */

const PER_SOURCE_LIMIT = 250;

export type AdminActivityKind =
  | 'credit-adjustment'
  | 'user-sanction'
  | 'post-moderation'
  | 'subject-moderation'
  | 'generation-moderation'
  | 'contact-triage'
  | 'payout';

export type AdminActivityEntry = {
  id: string;
  kind: AdminActivityKind;
  /** When the operator acted, not when the underlying record was created. */
  at: string;
  reviewerId: string | null;
  action: string;
  /** The account the action was taken against, when there is one. */
  subjectUserId: string | null;
  summary: string;
  /**
   * A timestamp belonging to the detail rather than to the action — currently
   * only a suspension's expiry. Kept raw so the page formats it with the same
   * UTC formatter as every other date, instead of a bare ISO string leaking
   * into the middle of a sentence.
   */
  summaryUntil: string | null;
  rationale: string | null;
};

export type AdminActivityFeed = {
  entries: AdminActivityEntry[];
  total: number;
  offset: number;
  pageSize: number;
  truncated: boolean;
};

function rows(result: { data: unknown; error: unknown }): Array<Record<string, unknown>> {
  if (result.error) throw result.error;
  return (result.data ?? []) as Array<Record<string, unknown>>;
}

function creditSummary(row: Record<string, unknown>): string {
  const credits = Number(row.credits_delta ?? 0);
  const promotional = Number(row.promotional_credits_delta ?? 0);
  const parts: string[] = [];
  if (credits !== 0) parts.push(`${credits > 0 ? '+' : ''}${credits} credits`);
  if (promotional !== 0) parts.push(`${promotional > 0 ? '+' : ''}${promotional} promotional`);
  return parts.join(', ') || 'no balance change';
}

export async function collectAdminActivity(
  client: SupabaseClient,
  options: { offset?: number; pageSize?: number } = {},
): Promise<AdminActivityFeed> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 200);
  const requestedOffset = Math.max(options.offset ?? 0, 0);

  const [credits, sanctions, postReports, subjectReports, payouts, generations, contact] = await Promise.all([
    client
      .from('admin_credit_adjustments')
      .select('id, user_id, reviewer_id, credits_delta, promotional_credits_delta, reason, created_at')
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    client
      .from('admin_user_sanctions')
      .select('id, user_id, reviewer_id, action, reason, suspended_until, created_at')
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    client
      .from('post_reports')
      .select('id, post_id, reviewed_by, reviewed_at, resolution_action, resolution_note')
      .not('reviewed_at', 'is', null)
      .order('reviewed_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    client
      .from('moderation_reports')
      .select('id, reported_user_id, reviewed_by, reviewed_at, status, resolution_note')
      .not('reviewed_at', 'is', null)
      .order('reviewed_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    client
      .from('creator_payout_requests')
      .select('id, user_id, resolved_by, resolved_at, status, resolution_note, amount_token_subunits')
      .not('resolved_at', 'is', null)
      .order('resolved_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    client
      .from('admin_generation_moderation_actions')
      .select('id, generation_id, reviewer_id, action, reason, created_at')
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    // Contact triage is a toggle on the row rather than an append-only log, so
    // the feed shows the current handled state rather than a history of it.
    client
      .from('contact_messages')
      .select('id, subject, handled_at, handled_by, handled_note')
      .not('handled_at', 'is', null)
      .order('handled_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT),
  ]);

  const creditRows = rows(credits);
  const sanctionRows = rows(sanctions);
  const postRows = rows(postReports);
  const subjectRows = rows(subjectReports);
  const payoutRows = rows(payouts);
  const generationRows = rows(generations);
  const contactRows = rows(contact);

  const entries: AdminActivityEntry[] = [
    ...creditRows.map((row) => ({
      id: `credit-${row.id}`,
      kind: 'credit-adjustment' as const,
      at: String(row.created_at ?? ''),
      reviewerId: (row.reviewer_id as string | null) ?? null,
      action: 'adjusted credits',
      subjectUserId: (row.user_id as string | null) ?? null,
      summary: creditSummary(row),
      summaryUntil: null,
      rationale: (row.reason as string | null) ?? null,
    })),
    ...sanctionRows.map((row) => ({
      id: `sanction-${row.id}`,
      kind: 'user-sanction' as const,
      at: String(row.created_at ?? ''),
      reviewerId: (row.reviewer_id as string | null) ?? null,
      action: row.action === 'reinstate' ? 'reinstated account' : 'suspended account',
      subjectUserId: (row.user_id as string | null) ?? null,
      summary: row.action === 'reinstate' ? 'Sign-in restored' : 'Sign-in blocked until',
      summaryUntil: row.action === 'reinstate' ? null : (row.suspended_until as string | null) ?? null,
      rationale: (row.reason as string | null) ?? null,
    })),
    ...postRows.map((row) => ({
      id: `post-report-${row.id}`,
      kind: 'post-moderation' as const,
      at: String(row.reviewed_at ?? ''),
      reviewerId: (row.reviewed_by as string | null) ?? null,
      action: row.resolution_action === 'take_down' ? 'took down a post' : 'dismissed a post report',
      subjectUserId: null,
      summary: `Post ${String(row.post_id ?? '').slice(0, 8)}…`,
      summaryUntil: null,
      rationale: (row.resolution_note as string | null) ?? null,
    })),
    ...subjectRows.map((row) => ({
      id: `subject-report-${row.id}`,
      kind: 'subject-moderation' as const,
      at: String(row.reviewed_at ?? ''),
      reviewerId: (row.reviewed_by as string | null) ?? null,
      action: row.status === 'dismissed' ? 'dismissed a report' : 'resolved a report',
      subjectUserId: (row.reported_user_id as string | null) ?? null,
      summary: 'User, generation or comment report',
      summaryUntil: null,
      rationale: (row.resolution_note as string | null) ?? null,
    })),
    ...payoutRows.map((row) => ({
      id: `payout-${row.id}`,
      kind: 'payout' as const,
      at: String(row.resolved_at ?? ''),
      reviewerId: (row.resolved_by as string | null) ?? null,
      action: row.status === 'paid' ? 'marked a payout paid' : 'rejected a payout',
      subjectUserId: (row.user_id as string | null) ?? null,
      summary: `${Number(row.amount_token_subunits ?? 0) / 10000} tokens`,
      summaryUntil: null,
      rationale: (row.resolution_note as string | null) ?? null,
    })),
    ...generationRows.map((row) => ({
      id: `generation-${row.id}`,
      kind: 'generation-moderation' as const,
      at: String(row.created_at ?? ''),
      reviewerId: (row.reviewer_id as string | null) ?? null,
      action: row.action === 'restore' ? 'restored a generation' : 'removed a generation',
      subjectUserId: null,
      summary: `Generation ${String(row.generation_id ?? '').slice(0, 8)}…`,
      summaryUntil: null,
      rationale: (row.reason as string | null) ?? null,
    })),
    ...contactRows.map((row) => ({
      id: `contact-${row.id}`,
      kind: 'contact-triage' as const,
      at: String(row.handled_at ?? ''),
      reviewerId: (row.handled_by as string | null) ?? null,
      action: 'handled an enquiry',
      subjectUserId: null,
      summary: String(row.subject || 'No subject'),
      summaryUntil: null,
      rationale: (row.handled_note as string | null) ?? null,
    })),
  ].sort((left, right) => right.at.localeCompare(left.at));

  // Matches runPagedQuery's contract: an offset past the end shows the first
  // page rather than an empty table.
  const offset = requestedOffset >= entries.length ? 0 : requestedOffset;

  return {
    entries: entries.slice(offset, offset + pageSize),
    total: entries.length,
    offset,
    pageSize,
    truncated: [creditRows, sanctionRows, postRows, subjectRows, payoutRows, generationRows, contactRows]
      .some((source) => source.length >= PER_SOURCE_LIMIT),
  };
}
