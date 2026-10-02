/**
 * The attempt cap of the generation completion queue.
 *
 * Separate from `generation-completion-jobs.ts` on purpose. The worker and
 * backend health both need the number, and health cannot import the worker:
 * that module reaches sharp and ffmpeg-static through `generation-services.ts`,
 * and the ops routes that serve health are on neither trace list in
 * `next.config.ts`. A module with no imports lets both read one value.
 *
 * Every claim adds an attempt, a reclaim of an expired lock included.
 * `finish_generation_completion_job` closes a job as `failed` once its
 * `attempt_count` has reached this number, so a job that is still open above it
 * was claimed again without ever being closed.
 *
 * The SQL function carries the same number as a literal, which a migration
 * cannot read from here. `generation-completion-job-policy.test.ts` fails when
 * the two stop agreeing: raising the cap takes a migration as well.
 */
export const MAX_COMPLETION_ATTEMPTS = 5;
