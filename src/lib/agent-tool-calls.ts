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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  let query = admin
    .from(AGENT_TOOL_CALLS_TABLE)
    .select('post_id, user_id, client_id, created_at')
    .eq('tool', 'publish_post')
    .eq('ok', true)
    .not('post_id', 'is', null)
    .order('created_at', { ascending: false });
  if (postIds) {
    if (postIds.length === 0) return [];
    query = query.in('post_id', [...postIds]);
  }
  // Several calls may name one post; the page is of posts, so more rows are read than posts kept.
  const { data, error } = await query.limit(Math.max(limit * 4, limit));
  if (error) throw error;
  const seen = new Map<string, AgentPublishedPostRecord>();
  for (const row of (data ?? []) as Array<{ post_id: string; user_id: string; client_id: string; created_at: string }>) {
    // Newest first in the read: a post keeps its place from its newest call and, each older call
    // overwriting the date, ends with the date of its first publication.
    seen.set(row.post_id, { postId: row.post_id, userId: row.user_id, clientId: row.client_id, publishedAt: row.created_at });
  }
  return [...seen.values()].slice(0, limit);
}
