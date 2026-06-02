import { afterEach, describe, expect, it, vi } from 'vitest';

describe('mobile env helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('reports missing Supabase env without throwing at import time', async () => {
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    vi.resetModules();

    const { getMissingMobileEnvKeys, isMobileEnvConfigured, requireMobileEnv } = await import('../lib/env');

    expect(getMissingMobileEnvKeys()).toEqual([
      'EXPO_PUBLIC_SUPABASE_URL',
      'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    ]);
    expect(isMobileEnvConfigured()).toBe(false);
    expect(requireMobileEnv).toThrow(/Missing mobile environment values/);
  });

  it('treats Supabase env as configured when both public values are present', async () => {
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'publishable-key');
    vi.resetModules();

    const { getMissingMobileEnvKeys, isMobileEnvConfigured } = await import('../lib/env');

    expect(getMissingMobileEnvKeys()).toEqual([]);
    expect(isMobileEnvConfigured()).toBe(true);
  });

  it('uses the web API base URL only in browser preview', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'https://magicbooklet.com');
    vi.stubEnv('EXPO_PUBLIC_WEB_API_BASE_URL', 'http://localhost:3000');
    vi.stubGlobal('window', { document: {} });
    vi.resetModules();

    const { env } = await import('../lib/env');

    expect(env.apiBaseUrl).toBe('http://localhost:3000');
  });

  it('keeps the native API base URL outside browser preview', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'https://magicbooklet.com');
    vi.stubEnv('EXPO_PUBLIC_WEB_API_BASE_URL', 'http://localhost:3000');
    vi.resetModules();

    const { env } = await import('../lib/env');

    expect(env.apiBaseUrl).toBe('https://magicbooklet.com');
  });
});
