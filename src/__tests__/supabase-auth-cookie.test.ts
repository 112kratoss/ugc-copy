import { describe, expect, it } from 'vitest';

import {
  getSupabaseAuthCookiePrefix,
  hasSupabaseAuthCookie,
} from '@/lib/supabase-auth-cookie';

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
