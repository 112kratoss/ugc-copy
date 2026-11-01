/**
 * An access token shaped as Supabase issues one, unsigned: base64url segments whose payload
 * carries the claims given (`sub`, `session_id`). For code that reads a token's claims without
 * verifying it; nothing that checks a signature accepts it.
 */
export function unsignedJwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}
