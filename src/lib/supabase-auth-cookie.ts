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
 * The account id in this browser's Supabase session cookie, read without
 * asking Supabase: null when there is no cookie or it cannot be read. A hint
 * only, like `hasSupabaseAuthCookie`: it says whose session the cookie names,
 * never that it is valid. The share links use it to keep one account's invite
 * code off a link shared after another account (or nobody) took over the
 * browser on a page that runs no auth provider.
 *
 * @supabase/ssr writes the session as `base64-` + base64url(JSON), split into
 * `<name>.0`, `<name>.1`, … when it is long.
 */
export function readSupabaseAuthCookieUserId(
  cookieHeader = typeof document === 'undefined' ? '' : document.cookie,
  configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
): string | null {
  const prefix = getSupabaseAuthCookiePrefix(configuredUrl);
  if (!prefix || !cookieHeader) return null;

  let whole: string | null = null;
  const chunks: Array<[number, string]> = [];
  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) continue;
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (name === prefix) whole = value;
    else if (name.startsWith(`${prefix}.`)) {
      const index = Number(name.slice(prefix.length + 1));
      if (Number.isInteger(index) && index >= 0) chunks.push([index, value]);
    }
  }
  const raw = whole ?? (chunks.length > 0
    ? chunks.sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('')
    : null);
  if (!raw) return null;

  try {
    let text = decodeURIComponent(raw);
    if (text.startsWith('base64-')) {
      const encoded = text.slice('base64-'.length).replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(encoded + '='.repeat((4 - (encoded.length % 4)) % 4));
      text = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    }
    const session: unknown = JSON.parse(text);
    const user = session && typeof session === 'object' ? (session as { user?: unknown }).user : null;
    const id = user && typeof user === 'object' ? (user as { id?: unknown }).id : null;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
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
