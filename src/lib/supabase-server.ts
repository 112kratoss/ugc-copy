import 'server-only';

import { cache } from 'react';
import { createServerClient } from '@supabase/ssr';
import type { Session } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import { createServiceClient } from '@/lib/server-helpers';

async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components cannot always set auth cookies.
          }
        },
      },
    }
  );
}

export interface ServerAuthState {
  session: Session | null;
  credits: number | null;
}

export const getServerAuthState = cache(async (): Promise<ServerAuthState> => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    return {
      session: null,
      credits: null,
    };
  }

  const adminSupabase = createServiceClient();
  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('credits')
    .eq('id', session.user.id)
    .maybeSingle();

  return {
    session,
    credits: profile?.credits ?? null,
  };
});
