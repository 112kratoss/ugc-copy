import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The audit table of the MCP server, `public.agent_tool_calls`: one row per tool call an agent
 * made as a creator, written by the service role after the tool has answered
 * (`mcp-route-adapter-service.ts`) and never in the way of the answer. The owner may read their
 * own rows (RLS); nothing else reads it but the service role, for moderation, which lists the
 * posts agents published from it (`moderation-ops.ts`, `list --source agent`).
 *
 * Loaded by the moderation CLI under plain tsx (`scripts/ops/moderation-ops.ts`), so nothing here
 * may reach `server-only`.
 */

export const AGENT_TOOL_CALLS_TABLE = 'agent_tool_calls';

/**
 * What a successful `publish_post` records in the row's `code` column (an error code otherwise):
 * which of its answers it gave, so the daily cap counts public publications and the moderation
 * list sees the posts the agent made or changed.
 */
export const AGENT_PUBLISH_RECORD_CODES = {
  /** A new public post, or an existing post made public: what the daily cap counts. */
  PUBLISHED_PUBLIC: 'PUBLISHED_PUBLIC',
  /** A new private post. */
  PUBLISHED_PRIVATE: 'PUBLISHED_PRIVATE',
  /** An existing public post made private. */
  MADE_PRIVATE: 'MADE_PRIVATE',
  /**
   * The existing post returned as it was. For a creation's post the row names no post (the agent
   * made none: the creator may have published it by hand). For a post made from uploads the row
   * names it, since only an agent's publish makes such a post, whichever call's row was written.
   */
  ALREADY_PUBLISHED: 'ALREADY_PUBLISHED',
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Midnight UTC of the day `now` falls in: the start of the daily cap's window. */
export function startOfUtcDay(now: number): Date {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** The next midnight UTC: when the daily cap's window resets. */
export function nextUtcMidnight(now: number): Date {
  const start = startOfUtcDay(now);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * How many public publications an agent made for the account since `since` (the day's start):
 * the daily cap's count, read from the ledger rather than the attempt-counting limiter, so a
 * refused publish spends nothing. The row is written behind the answer, so two publishes a few
 * hundred milliseconds apart may both pass the count; the cap is a guard against a loop, not an
 * exact quota, and the runbook says so.
 */
export async function countAgentPublicPublishesSince(
  admin: SupabaseClient,
  { userId, since }: { userId: string; since: Date },
): Promise<number> {
  const { count, error } = await admin
    .from(AGENT_TOOL_CALLS_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('tool', 'publish_post')
    .eq('ok', true)
    .eq('code', AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PUBLIC)
    .gte('created_at', since.toISOString());
  if (error) throw error;
  return count ?? 0;
}

export type AgentToolCallRow = {
  user_id: string;
  client_id: string;
  tool: string;
  ok: boolean;
  code: string | null;
  generation_id: string | null;
  post_id: string | null;
  cost_credits: number | null;
};

/** A UUID as the table's columns take one, or null for anything else (an agent's argument is its word). */
export function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim()) ? value.trim().toLowerCase() : null;
}

export function buildAgentToolCallRow(input: {
  userId: string;
  clientId: string;
  tool: string;
  ok: boolean;
  code?: string | null;
  generationId?: unknown;
  postId?: unknown;
  costCredits?: number | null;
}): AgentToolCallRow {
  const cost = input.costCredits;
  return {
    user_id: input.userId,
    client_id: input.clientId.slice(0, 200),
    tool: input.tool.slice(0, 64),
    ok: input.ok,
    code: input.code ? input.code.slice(0, 64) : null,
    generation_id: uuidOrNull(input.generationId),
    post_id: uuidOrNull(input.postId),
    cost_credits: typeof cost === 'number' && Number.isInteger(cost) && cost >= 0 ? cost : null,
  };
}

/**
 * Writes one row. Never throws: the tool has answered by the time this runs, and a row that could
 * not be written is the operator's to notice in the log, not the agent's.
 */
export async function recordAgentToolCall(
  admin: SupabaseClient,
  row: AgentToolCallRow,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    const { error } = await admin.from(AGENT_TOOL_CALLS_TABLE).insert(row);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export type AgentPublishedPostRecord = {
  postId: string;
  userId: string;
  clientId: string;
  publishedAt: string;
  /**
   * The creation the post was published from, as its row names it; null for a post with no
   * creation behind it (`publish_post` with `uploads`, or a text post). Which of those two it is
   * the row does not say: the post itself does (`moderation-ops.ts` reads its format).
   */
  generationId: string | null;
};

/**
 * The posts agents published, newest first: every successful `publish_post` that answered a post,
 * one row per post (an agent that republished the same post is listed once, at its first
 * publication). Moderation reads it to list and review what agents put on the feed.
 */
export async function listAgentPublishedPosts(
  admin: SupabaseClient,
  { limit, postIds }: { limit: number; postIds?: readonly string[] },
): Promise<AgentPublishedPostRecord[]> {
  if (postIds && postIds.length === 0) return [];
  type Row = { post_id: string; user_id: string; client_id: string; created_at: string; generation_id?: string | null };
  const rows = (repeats: boolean, rowLimit: number) => {
    let query = admin
      .from(AGENT_TOOL_CALLS_TABLE)
      .select('post_id, user_id, client_id, created_at, generation_id')
      .eq('tool', 'publish_post')
      .eq('ok', true)
      .not('post_id', 'is', null);
    query = repeats
      ? query.eq('code', AGENT_PUBLISH_RECORD_CODES.ALREADY_PUBLISHED)
      : query.or(`code.is.null,code.neq.${AGENT_PUBLISH_RECORD_CODES.ALREADY_PUBLISHED}`);
    if (postIds) query = query.in('post_id', [...postIds]);
    return query.order('created_at', { ascending: false }).limit(rowLimit);
  };
  // Two reads, so the rows of one kind cannot push the other out. Publications and visibility
  // changes pass the publish limit, so their number is bounded; several may name one post, and
  // the page is of posts, so more rows are read than posts kept. An unchanged repeat of a text or
  // upload post names its post too (for the publish whose own row was lost) and spends no limit:
  // read with the publications, a loop of them would fill the page and hide every other agent's
  // posts from moderation (PR #751's review). They get a page of their own.
  const [publications, repeated] = await Promise.all([rows(false, Math.max(limit * 4, limit)), rows(true, limit)]);
  if (publications.error) throw publications.error;
  if (repeated.error) throw repeated.error;
  const data = [...((publications.data ?? []) as Row[]), ...((repeated.data ?? []) as Row[])]
    .sort((left, right) => (left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : 0));
  const seen = new Map<string, AgentPublishedPostRecord>();
  for (const row of data) {
    // Newest first in the read: a post keeps its place from its newest call and, each older call
    // overwriting the date, ends with the date of its first publication. Every call about one post
    // names the same creation or none, so it is the same whichever row is kept.
    seen.set(row.post_id, {
      postId: row.post_id,
      userId: row.user_id,
      clientId: row.client_id,
      publishedAt: row.created_at,
      generationId: row.generation_id ?? null,
    });
  }
  return [...seen.values()].slice(0, limit);
}
