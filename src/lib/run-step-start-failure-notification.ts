import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { getRefundedStartGenerationId } from '@/lib/generation-public-failure';
import { notifyGenerationStatus, type GenerationNotificationSubject } from '@/lib/mobile-notifications';

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
 * back so the wording comes from the stored row, and so does the link: a
 * template step's leads to its run, where the step is retried. Nothing here
 * throws: the step is failed and its credits are back whatever becomes of the
 * notification.
 */
export async function notifyRunStepStartFailure(params: {
  /** Service-role: it reads the generation and writes the notification. */
  client: SupabaseClient;
  error: unknown;
  userId: string;
}): Promise<void> {
  const generationId = getRefundedStartGenerationId(params.error);
  if (!generationId) return;

  await notifyRunStepGenerationFailed({ client: params.client, generationId, userId: params.userId });
}

/**
 * Tells the creator that a run step's generation has failed, by its id.
 *
 * A template step that follows a generation it was started with earlier can
 * find it failed already, with nobody having said so: the pass that started
 * it put the step back in line in place of failing it. The notification is
 * keyed by the generation, so one that was announced when it failed is not
 * announced again. Nothing here throws.
 */
export async function notifyRunStepGenerationFailed(params: {
  /** Service-role: it reads the generation and writes the notification. */
  client: SupabaseClient;
  generationId: string;
  userId: string;
}): Promise<void> {
  const { generationId } = params;

  try {
    const { data, error } = await params.client
      .from('generations')
      .select('id, user_id, category, model, template_run_id')
      .eq('id', generationId)
      .eq('user_id', params.userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return;

    await notifyGenerationStatus(params.client, data as GenerationNotificationSubject, 'failed');
  } catch (error) {
    logBackendError('failed_to_notify_run_step_start_failure', { generationId, error });
  }
}
