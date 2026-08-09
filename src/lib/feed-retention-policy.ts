/**
 * Feed telemetry retention windows.
 *
 * Separate from `feed-maintenance.ts` on purpose. These are configuration that
 * both the sweep and the lag monitor need to agree on, and the sweep is mocked
 * wholesale by its route tests — so a monitor importing the numbers from there
 * breaks the moment someone mocks the module for an unrelated reason. Keeping
 * the policy free of the implementation lets both sides read the same value
 * without either depending on the other's behaviour.
 */

export const FEED_EVENT_RETENTION_DAYS = 90;

export const FEED_SESSION_RETENTION_DAYS = 2;

/**
 * F7b / decision #2 — 30 days, down from 400.
 *
 * The arithmetic behind the 5,000 MAU gate runs on this number: at ~60,000
 * facts/day, 400 days is ~24M rows, and rows measure ~1 KB each in production
 * (14 MB across 14,983 rows, dominated by `score_components`), so the old
 * setting projected roughly 24 GiB against an 8 GiB included quota.
 *
 * Raw facts are not the experiment-lookback mechanism — daily aggregates are,
 * and those are still to be built. **Nothing is deleted by this change until
 * 2026-08-27**: the oldest fact in production is 2026-07-28, so there is a real
 * window in which the aggregates must land. After it, this setting begins
 * discarding history that nothing else retains.
 */
export const FEED_FACT_RETENTION_DAYS = 30;

/**
 * Rows deleted per sweep run, per table. The sweep is hourly, so this is also
 * the ceiling the insert rate has to stay under for retention to hold — which
 * is what `feed-retention-lag.ts` exists to detect.
 */
export const FEED_RETENTION_PRUNE_LIMIT = 5000;
