/**
 * The id a queued run is followed by.
 *
 * Every client follows a run by the id its start answered, `predictionId`, and
 * the status checks look the run up by it. That id is the provider's task, and
 * a queued run has none yet. Its start answers the generation's own id in that
 * place: a handle the status checks accept until the task exists, and after.
 * A client never has to change the id it holds, and one written before the
 * queue follows a queued run without knowing it was queued.
 *
 * The two cannot be confused. A generation id is a UUID; the provider's task
 * ids are 32 hex characters with no dashes, or `veo_task_…`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an id a client sent to follow a run is a run handle, not a provider task. */
export function isRunHandle(id: string | null | undefined): id is string {
  return typeof id === 'string' && UUID.test(id.trim());
}

/** Whether a start answered a queued run: the id to follow it by is the generation's own. */
export function isQueuedRunHandle(result: { predictionId: string; generationId?: string | null }): boolean {
  return Boolean(result.generationId) && result.predictionId === result.generationId && isRunHandle(result.predictionId);
}
