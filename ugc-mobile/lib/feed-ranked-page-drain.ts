/**
 * What a ranked lane's page one waits for before it is asked
 * (`showcaseFeedLaneQueryOptions`): a For you page one can start a new ranked
 * session, whose seen check reads the impressions recorded by then, so the
 * feed-event queue is sent first (`flushShowcaseFeedEventsBeforeRefresh`, at
 * most 1.5 s). The root layout installs it at launch; this module imports
 * nothing, so the lane builder and its tests carry no part of the queue.
 */

let drain: (() => Promise<void>) | null = null;

export function installRankedFirstPageDrain(next: (() => Promise<void>) | null) {
  drain = next;
}

/** Settles once the queue has been sent, or at once when nothing is installed. Never rejects. */
export function drainBeforeRankedFirstPage(): Promise<void> {
  return drain ? drain().catch(() => undefined) : Promise.resolve();
}
