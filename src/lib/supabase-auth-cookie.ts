export function getSupabaseAuthCookiePrefix(
  configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
): string | null {
  if (!configuredUrl) {
    return null;
  }

  try {
    const projectRef = new URL(configuredUrl).hostname.split('.')[0];
    return projectRef ? `sb-${projectRef}-auth-token` : null;
  } catch {
    return null;
  }
}

/**
 * This is only an SDK-loading hint. Cookie presence or contents are not
 * authentication; consumers must verify any candidate session with Supabase.
 */
export function hasSupabaseAuthCookie(
  cookieHeader = typeof document === 'undefined' ? '' : document.cookie,
  configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
): boolean {
  const prefix = getSupabaseAuthCookiePrefix(configuredUrl);
  if (!prefix || !cookieHeader) {
    return false;
  }

  return cookieHeader.split(';').some((part) => {
    const cookieName = part.trim().split('=', 1)[0];
    return cookieName === prefix || cookieName.startsWith(`${prefix}.`);
  });
}

/**
 * Ends this browser's Supabase session without asking Supabase: expires the
 * session cookie (or its chunks) and the PKCE verifier and user cookies beside
 * it. A sign-out whose logout call fails (offline, a 5xx, the deadline) gets
 * `{ error }` back from auth-js with the session kept, and /login sends a
 * browser that still holds one straight back where it came from; a person who
 * chose to sign out must still leave signed out. The cookies are written by
 * @supabase/ssr with its defaults (path `/`, no domain, readable by scripts),
 * so the same scope removes them.
 */
export function removeSupabaseAuthCookies(
  configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
): void {
  const prefix = getSupabaseAuthCookiePrefix(configuredUrl);
  if (!prefix || typeof document === 'undefined') {
    return;
  }

  for (const part of document.cookie.split(';')) {
    const cookieName = part.trim().split('=', 1)[0];
    if (
      cookieName === prefix
      || cookieName.startsWith(`${prefix}.`)
      || cookieName.startsWith(`${prefix}-`)
    ) {
      document.cookie = `${cookieName}=; Max-Age=0; Path=/; SameSite=Lax`;
    }
  }
}
