import { describe, expect, it } from 'vitest';

import { supabaseSessionId } from '../lib/supabase-session-id';

function tokenWith(claims: Record<string, unknown>) {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'ES256' })}.${encode(claims)}.signature`;
}

describe("a Supabase access token's session", () => {
  it('is its session_id claim, which a refreshed token keeps and a new sign-in does not', () => {
    expect(supabaseSessionId(tokenWith({ sub: 'user-1', session_id: 'session-1', exp: 1 }))).toBe('session-1');
    expect(supabaseSessionId(tokenWith({ sub: 'user-1', session_id: 'session-1', exp: 2 }))).toBe('session-1');
  });

  it('is nothing for a token it cannot read', () => {
    expect(supabaseSessionId(null)).toBeNull();
    expect(supabaseSessionId('access-token')).toBeNull();
    expect(supabaseSessionId(tokenWith({ sub: 'user-1' }))).toBeNull();
    expect(supabaseSessionId('a.%%%.c')).toBeNull();
  });
});
