import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { getRefundedStartGenerationId } from '@/lib/generation-public-failure';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';

/**
 * Tells the creator that a run step was refused at start.
 *
 * A standalone creation hears a refusal in the response to the request that
 * started it. A run step is started by a worker with no request to answer, and
 * a run sends no notification of its own, so this is the only word the person
 * gets that the run stopped here.
 *
 * The run workers call it where they fail the step, and only there. A start
 * the provider was too busy for is refunded as well, but its step goes back in
 * the queue and is started again with a new generation: sent from the
 * settlement, each of those tries would announce a failure for a step that has
 * not failed. A start whose submission may have been accepted keeps its hold,
 * and nothing has failed yet.
 *
 * Only a start whose settlement released the hold itself is announced, which
 * the start service marks on the error it rethrows. The generation is read
 * back so the wording comes from the stored row. Nothing here throws: the step
 * is failed and its credits are back whatever becomes of the notification.
 */
export async function notifyRunStepStartFailure(params: {
  /** Service-role: it reads the generation and writes the notification. */
  client: SupabaseClient;
  error: unknown;
  userId: string;
}): Promise<void> {
  const generationId = getRefundedStartGenerationId(params.error);
  if (!generationId) return;

  try {
    const { data, error } = await params.client
      .from('generations')
      .select('id, user_id, category, model')
      .eq('id', generationId)
      .eq('user_id', params.userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return;

    await notifyGenerationStatus(
      params.client,
      data as { id: string; user_id: string; category: string | null; model: string | null },
      'failed',
    );
  } catch (error) {
    logBackendError('failed_to_notify_run_step_start_failure', { generationId, error });
  }
}
