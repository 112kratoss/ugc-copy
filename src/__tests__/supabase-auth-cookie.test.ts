import { afterEach, describe, expect, it } from 'vitest';

import {
  getSupabaseAuthCookiePrefix,
  hasSupabaseAuthCookie,
  removeSupabaseAuthCookies,
} from '@/lib/supabase-auth-cookie';

function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.trim().split('=', 1)[0];
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

describe('Supabase auth cookie hint', () => {
  it('derives the default SSR cookie prefix from the project URL', () => {
    expect(getSupabaseAuthCookiePrefix('https://project-ref.supabase.co'))
      .toBe('sb-project-ref-auth-token');
  });

  it('recognizes complete and chunked auth cookies only for this project', () => {
    const configuredUrl = 'https://project-ref.supabase.co';
    const prefix = getSupabaseAuthCookiePrefix(configuredUrl);
    expect(prefix).toBeTruthy();
    expect(hasSupabaseAuthCookie(`${prefix}=session`, configuredUrl)).toBe(true);
    expect(hasSupabaseAuthCookie(`${prefix}.0=chunk`, configuredUrl)).toBe(true);
    expect(hasSupabaseAuthCookie('sb-another-project-auth-token=session', configuredUrl)).toBe(false);
  });
});

// Audit 04-4: a sign-out whose logout call fails must still leave this browser signed out.
describe('removeSupabaseAuthCookies', () => {
  const configuredUrl = 'https://project-ref.supabase.co';

  afterEach(clearCookies);

  it('expires this project\'s session, its chunks and the cookies beside it, and nothing else', () => {
    document.cookie = 'sb-project-ref-auth-token.0=chunk-zero; Path=/';
    document.cookie = 'sb-project-ref-auth-token.1=chunk-one; Path=/';
    document.cookie = 'sb-project-ref-auth-token-code-verifier=verifier; Path=/';
    document.cookie = 'sb-project-ref-auth-token-user=user; Path=/';
    document.cookie = 'sb-another-project-auth-token=theirs; Path=/';
    document.cookie = 'theme=dark; Path=/';
    expect(hasSupabaseAuthCookie(document.cookie, configuredUrl)).toBe(true);

    removeSupabaseAuthCookies(configuredUrl);

    expect(document.cookie).toBe('sb-another-project-auth-token=theirs; theme=dark');
    expect(hasSupabaseAuthCookie(document.cookie, configuredUrl)).toBe(false);
  });

  it('removes an unchunked session cookie', () => {
    document.cookie = 'sb-project-ref-auth-token=base64-session; Path=/';

    removeSupabaseAuthCookies(configuredUrl);

    expect(document.cookie).toBe('');
  });

  it('does nothing without a configured project', () => {
    document.cookie = 'sb-project-ref-auth-token=base64-session; Path=/';

    removeSupabaseAuthCookies('');

    expect(document.cookie).toBe('sb-project-ref-auth-token=base64-session');
  });
});
