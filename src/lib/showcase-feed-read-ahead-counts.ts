import 'server-only';

import { logBackendWarning } from '@/lib/backend-logger';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * Counts for Explore's read-ahead (`showcase-feed-read-ahead.ts`), kept so that
 * whether it earns its cost can be decided from a week of them. Every launch of
 * the app asks for one, a whole ranking plus a data-cache write, and it pays off
 * only when Explore's first read claims it within 100 s.
 *
 * One row per event per hour in `showcase_feed_read_ahead_counters`:
 * - `hold`: a ranking was held and its token handed to the app;
 * - `claim`: a read handed its token back and was served the held ranking;
 * - `claim_miss`: a read handed its token back and was served one of its own.
 * A hold neither claimed nor missed is one whose Explore did not open in time.
 *
 * Read a week of them (service role):
 *   select event, sum(event_count) from public.showcase_feed_read_ahead_counters
 *   where bucket_start >= now() - interval '7 days' group by event;
 */
export type ShowcaseFeedReadAheadEvent = 'hold' | 'claim' | 'claim_miss';

/**
 * Adds one to this hour's count. Run after the response: a count must never
 * slow or fail the read it counts, so a failure is only logged, which leaves
 * that hour short by one.
 */
export async function recordShowcaseFeedReadAheadEvent(
  event: ShowcaseFeedReadAheadEvent,
  dependencies: {
    createServiceClient?: typeof createServiceClient;
    logWarning?: typeof logBackendWarning;
  } = {},
): Promise<void> {
  const logWarning = dependencies.logWarning ?? logBackendWarning;
  try {
    const client = (dependencies.createServiceClient ?? createServiceClient)();
    const { error } = await client.rpc('record_showcase_feed_read_ahead_event', { p_event: event });
    if (error) logWarning('showcase_feed_read_ahead_count_failed', { event, message: error.message });
  } catch (error) {
    logWarning('showcase_feed_read_ahead_count_failed', {
      event,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
