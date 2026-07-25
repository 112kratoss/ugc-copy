import 'server-only';
import { logBackendWarning } from '@/lib/backend-logger';

import { createServerClient, type CookieOptionsWithName } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import {
  getSafeAuthNextPath,
  isPasswordRecoveryPath,
  resolvePostAuthPath,
} from '@/lib/auth-onboarding';

interface AuthProfileRow {
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_url: string | null;
}

export async function createAuthRouteClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options: CookieOptionsWithName }>) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );
}

export async function resolveServerPostAuthPath(
  supabase: SupabaseClient,
  userId: string,
  next: string | null | undefined,
  options: { skipProfileOnboarding?: boolean } = {}
): Promise<string> {
  const safeNext = getSafeAuthNextPath(next);
  if (isPasswordRecoveryPath(safeNext)) {
    return safeNext;
  }

  if (options.skipProfileOnboarding) {
    return safeNext;
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('username, display_name, bio, avatar_url, cover_url')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logBackendWarning('could_not_check_profile_readiness_after_authentication', { error: error.message });
  }

  const profile = data as AuthProfileRow | null;
  return resolvePostAuthPath(
    profile
      ? {
          username: profile.username,
          displayName: profile.display_name,
          bio: profile.bio,
          avatarUrl: profile.avatar_url,
          coverUrl: profile.cover_url,
        }
      : null,
    safeNext
  );
}
