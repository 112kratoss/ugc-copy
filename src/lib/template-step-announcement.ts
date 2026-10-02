import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { isRecord } from '@/lib/media-template-types';
import type { FinishedTemplateStep } from '@/lib/mobile-notifications';
import {
  getNodeById,
  getOutgoingEdges,
  isApprovalGateNode,
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';

/**
 * What a finished template step means to the person who started the run.
 *
 * - `review`: its result goes to a review, and the run stops there until the
 *   person approves it. The notification is the only word that it is waiting.
 * - `result`: it is the run's output. A published template holds only what its
 *   output is made from, so by the time this step finishes every other step
 *   has, and the run finishes with it.
 * - `intermediate`: the run carries on from it by itself. The person asked for
 *   the result, so nothing is said.
 * - `unplaced`: the run or the step could not be read, so none of the above can
 *   be told from the others.
 */
export type FinishedTemplateStepPlace = FinishedTemplateStep | 'intermediate' | 'unplaced';

/**
 * Places a finished step in its run from what the run stored when it started:
 * the graph it was published with and the node it named as its output. It
 * reads, it never writes, and it never throws: the file is imported and the
 * credits are settled whatever becomes of the announcement.
 */
export async function placeFinishedTemplateStep(
  /** Service-role: template runs are read past row-level security. */
  client: SupabaseClient,
  generation: { id: string; template_run_id: string; template_run_step_id?: string | null },
): Promise<FinishedTemplateStepPlace> {
  const runId = generation.template_run_id;
  const stepId = generation.template_run_step_id ?? null;

  try {
    if (!stepId) throw new Error('The generation names a run and no step.');

    const [step, run] = await Promise.all([
      client.from('template_run_steps').select('node_id').eq('id', stepId).eq('run_id', runId).maybeSingle(),
      client.from('template_runs').select('output_node_id, graph_snapshot').eq('id', runId).maybeSingle(),
    ]);
    if (step.error) throw step.error;
    if (run.error) throw run.error;

    const nodeId = (step.data as { node_id?: unknown } | null)?.node_id;
    if (typeof nodeId !== 'string' || !nodeId) throw new Error('The step is gone.');
    if (!run.data) throw new Error('The run is gone.');

    const stored = run.data as { output_node_id?: unknown; graph_snapshot?: unknown };
    const graph = normalizeWorkflowGraph(
      isRecord(stored.graph_snapshot) ? stored.graph_snapshot.graph as Partial<WorkflowCanvasGraph> : null,
    );
    if (!getNodeById(graph, nodeId)) throw new Error('The run stored no graph that holds this step.');

    if (nodeId === stored.output_node_id) return 'result';

    const reviewed = getOutgoingEdges(graph, nodeId).some((edge) => {
      const next = getNodeById(graph, edge.target);
      return Boolean(next && isApprovalGateNode(next));
    });
    return reviewed ? 'review' : 'intermediate';
  } catch (error) {
    logBackendError('template_step_announcement_unplaced', { generationId: generation.id, runId, stepId, error });
    return 'unplaced';
  }
}
