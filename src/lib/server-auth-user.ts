import 'server-only';

/**
 * The sole low-level server boundary for Supabase's verified JWT user lookup.
 *
 * This authenticates the token only. User-facing route admission must still run
 * through the route-policy proxy and, where an adapter needs its own lifecycle
 * check, `requireIdentity` or `requireRegisteredUser`.
 */
export function getVerifiedAuthUserResult<TResult>(client: {
  auth: { getUser: () => TResult };
}): TResult {
  return client.auth.getUser();
}
