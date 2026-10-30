import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The run a creator page picks up when it opens: the caller's newest run of
 * that tool still at work, started in this tab before a reload, in another
 * tab or on another device (`GET /api/generations/active`).
 *
 * The browser used to read this from `generations` itself, but the Data API
 * grants `authenticated` only the resume columns of
 * 20260726071722_harden_data_api_and_storage_contract.sql, and the run's
 * prompt, cost and model were added to that read later: Postgres refused the
 * whole query (42501, a 403 from PostgREST) and the page opened idle on every
 * load. The read is the server's now, on the service client, scoped here to
 * the owner's ids. Runs a template or a workflow canvas started are their own
 * pages' to follow, and are left out.
 */

export const CREATOR_ACTIVE_RUN_TOOLS = ['image', 'video', 'motion'] as const;

export type CreatorActiveRunTool = (typeof CREATOR_ACTIVE_RUN_TOOLS)[number];

export type CreatorActiveRun = {
  id: string;
  /** What the run's status route is asked by (`/api/generate-image?id=…`). */
  predictionId: string;
  status: 'processing' | 'waiting';
  /** ISO 8601: the run's clock starts here. */
  createdAt: string;
  prompt: string | null;
  cost: number | null;
  /** The catalog model id the run was started on. */
  model: string | null;
  /** Seconds; the motion creator restores its duration from it. */
  duration: number | null;
};

const ACTIVE_RUN_STATUSES = ['processing', 'waiting'] as const;
/** Runs at work read at a time, newest first, until one is not a workflow canvas's. */
export const ACTIVE_RUN_PAGE = 10;

export function parseCreatorActiveRunTool(value: string | null): CreatorActiveRunTool | null {
  return CREATOR_ACTIVE_RUN_TOOLS.find((tool) => tool === value) ?? null;
}

type ActiveRunRow = {
  id: string;
  prediction_id: string;
  status: (typeof ACTIVE_RUN_STATUSES)[number];
  created_at: string;
  prompt: string | null;
  cost: number | null;
  model: string | null;
  duration: number | null;
};

async function readActiveRuns(client: SupabaseClient, userIds: string[], tool: CreatorActiveRunTool, from: number) {
  let query = client
    .from('generations')
    .select('id, prediction_id, status, created_at, prompt, cost, model, duration')
    .in('user_id', userIds)
    // A motion run is a video with a creation mode of its own, as each creator saves it.
    .eq('category', tool === 'image' ? 'image' : 'video')
    .in('status', ACTIVE_RUN_STATUSES)
    // Without a prediction there is nothing for the page to follow yet.
    .not('prediction_id', 'is', null)
    // A template run's steps belong to its run page, and their prompts to the template's author.
    .is('template_run_id', null)
    .is('template_run_step_id', null)
    // Deleted, or taken down by moderation: not a run to bring back.
    .is('archived_at', null);
  if (tool === 'video') query = query.is('creation_mode', null);
  if (tool === 'motion') query = query.eq('creation_mode', 'motion');

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(from, from + ACTIVE_RUN_PAGE - 1);
  if (error) throw error;
  return (data ?? []) as ActiveRunRow[];
}

/** The ids among `ids` that a workflow canvas step holds. */
async function readCanvasRuns(client: SupabaseClient, ids: string[]) {
  const { data, error } = await client
    .from('workflow_canvas_run_steps')
    .select('generation_id')
    .in('generation_id', ids);
  if (error) throw error;
  return new Set((data ?? []).map((step) => (step as { generation_id: string }).generation_id));
}

export async function findCreatorActiveRun({
  client,
  userIds,
  tool,
}: {
  /** The service client: `authenticated` may not read these columns. */
  client: SupabaseClient;
  /** The caller and every guest identity linked to it. */
  userIds: string[];
  tool: CreatorActiveRunTool;
}): Promise<CreatorActiveRun | null> {
  // A workflow canvas starts its nodes' runs as ordinary generations and follows them on
  // its own page; only the steps that hold them say so, and a large canvas holds many.
  for (let from = 0; ; from += ACTIVE_RUN_PAGE) {
    const rows = await readActiveRuns(client, userIds, tool, from);
    if (rows.length === 0) return null;
    const canvasRuns = await readCanvasRuns(client, rows.map((row) => row.id));
    const row = rows.find((candidate) => !canvasRuns.has(candidate.id));
    if (row) {
      return {
        id: row.id,
        predictionId: row.prediction_id,
        status: row.status,
        createdAt: row.created_at,
        prompt: row.prompt,
        cost: row.cost,
        model: row.model,
        duration: row.duration,
      };
    }
    if (rows.length < ACTIVE_RUN_PAGE) return null;
  }
}
