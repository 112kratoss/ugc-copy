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
