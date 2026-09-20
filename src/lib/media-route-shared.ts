import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createUserClient } from '@/lib/server-helpers';

async function createCookieSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Media requests are read-only; no cookie writes are needed.
        },
      },
    },
  );
}

export async function createMediaSupabaseClient(request: Request) {
  if (request.headers.get('Authorization')) {
    return createUserClient(request);
  }

  return createCookieSupabaseClient();
}

