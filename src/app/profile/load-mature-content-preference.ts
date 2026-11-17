import 'server-only';

import { isGuestUser } from '@/lib/account-identity';
import { createServiceClient } from '@/lib/server-helpers';
import { getServerAuthState } from '@/lib/supabase-server';

/**
 * The account's mature-content setting, read beside the owner's profile so the profile's Mature
 * content row draws it from its first frame: the row read "Loading your setting…" for up to a
 * second after the page was drawn while the browser asked for it (live, 2026-11-17).
 *
 * The read `GET /api/content-preferences` answers, for the callers it answers: a registered
 * account, its own row, a missing row being off. Null for a guest, whom the route refuses, and
 * when the read fails: the row then reads the setting itself, as it always did.
 */
export async function loadMatureContentPreference(): Promise<boolean | null> {
  const { session } = await getServerAuthState();
  const user = session?.user;
  if (!user || isGuestUser(user)) {
    return null;
  }

  try {
    const { data, error } = await createServiceClient()
      .from('content_preferences')
      .select('show_mature')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) {
      return null;
    }
    return (data as { show_mature?: unknown } | null)?.show_mature === true;
  } catch {
    return null;
  }
}
