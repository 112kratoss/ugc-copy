import { createServiceClient } from '@/lib/server-helpers';

/**
 * Count every provider call attempt, so a failure rate has a denominator.
 *
 * `provider_dependency_events` persists a row only when a call failed or ran
 * slow, which makes `failures / events` approach 1 no matter how healthy the
 * provider is — the population is the exceptions. The audit's F15a prescribes
 * a counter rather than a success row per call, and this is it: one hourly
 * bucket per service, incremented in place, read by the cost report as the
 * denominator for the same window.
 *
 * Fire-and-forget by design. The counter must never slow down or fail the
 * call it is counting, so every error — missing env in a test, a dropped
 * connection, a database without the migration yet — is swallowed. The cost
 * is an undercount exactly when the database is unreachable, which is a
 * window where the report has larger problems to surface.
 */
let defaultClient: ReturnType<typeof createServiceClient> | null = null;

export function recordProviderFetchAttempt(
  serviceName: string,
  dependencies: { createServiceClient?: typeof createServiceClient } = {},
): void {
  try {
    // The default client is memoized: this runs on every provider call, and
    // paying a client construction per attempt would make the counter a real
    // fraction of what it counts. Injected factories (tests) are not cached.
    const client = dependencies.createServiceClient
      ? dependencies.createServiceClient()
      : (defaultClient ??= createServiceClient());
    void client
      .rpc('record_provider_fetch_attempt', { p_service_name: serviceName })
      .then(() => undefined, () => undefined);
  } catch {
    // See above: counting must never affect the counted.
  }
}
