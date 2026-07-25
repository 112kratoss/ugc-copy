import 'server-only';

/**
 * Derives the client network address used for rate limiting and abuse
 * signals.
 *
 * `x-forwarded-for` can be extended by the client (its first entry is
 * whatever the caller sent), so a spoofed header would let one client mint
 * unlimited rate-limit identities. Vercel sets `x-vercel-forwarded-for` at
 * its edge from the real client connection, so it is preferred whenever
 * present; the legacy headers remain as fallbacks for local development and
 * non-Vercel environments.
 */
export function getClientNetworkKey(headers: Headers): string {
  const vercelForwardedFor = headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
  const forwardedFor = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = headers.get('x-real-ip')?.trim();

  return (vercelForwardedFor || forwardedFor || realIp || '127.0.0.1').slice(0, 128);
}
