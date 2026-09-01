import 'server-only';

import type { User } from '@supabase/supabase-js';

import { getVerifiedIdentityAdmission } from '@/lib/identity-admission-assertion';

/**
 * The sole low-level server boundary for Supabase's verified JWT user lookup.
 *
 * This authenticates the token only. User-facing route admission must still run
 * through the route-policy proxy and, where an adapter needs its own lifecycle
 * check, `requireIdentity` or `requireRegisteredUser`.
 */
export async function getVerifiedAuthUserResult<TResult extends PromiseLike<{
  data: { user: User | null };
  error: unknown;
}>>(client: {
  auth: { getUser: () => TResult };
}): Promise<Awaited<TResult>> {
  const admission = await getVerifiedIdentityAdmission(client);
  if (admission?.state === 'active') {
    return {
      data: { user: admission.user },
      error: null,
    } as Awaited<TResult>;
  }
  return await client.auth.getUser();
}

/**
 * Fetch the complete authoritative Auth user even when middleware supplied a
 * valid identity-admission assertion.
 *
 * Most routes should use `getVerifiedAuthUserResult` and reuse the assertion.
 * This narrower boundary is for operations that need Auth fields intentionally
 * excluded from it, such as provider identities and `last_sign_in_at` during
 * permanent account deletion.
 */
export async function getAuthoritativeAuthUserResult<TResult extends PromiseLike<{
  data: { user: User | null };
  error: unknown;
}>>(client: {
  auth: { getUser: () => TResult };
}): Promise<Awaited<TResult>> {
  return await client.auth.getUser();
}
