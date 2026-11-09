import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { isAgentToken } from '@/lib/agent-token';
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

/** Whether the cookie's session is an agent's token (agent-token.ts), read from the verified claims alone. */
async function cookieSessionIsAgentToken(client: Awaited<ReturnType<typeof createCookieSupabaseClient>>): Promise<boolean> {
  try {
    const { data } = await client.auth.getClaims();
    return isAgentToken(data?.claims);
  } catch {
    return false;
  }
}

export async function createMediaSupabaseClient(request: Request) {
  if (request.headers.get('Authorization')) {
    return createUserClient(request);
  }

  const cookieClient = await createCookieSupabaseClient();
  // An agent's OAuth-issued token placed in the auth cookie verifies like any user token, and the
  // adapters' `requireIdentity` would take it from this client. It drives /api/mcp alone
  // (`supabase-server.ts` refuses it as a page session the same way), so the request is served
  // as one with no session: the anon client, which reads no cookie.
  if (await cookieSessionIsAgentToken(cookieClient)) {
    return createUserClient(request);
  }

  return cookieClient;
}
