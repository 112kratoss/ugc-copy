import { beforeEach, describe, expect, it, vi } from 'vitest';

const createClientMock = vi.hoisted(() => vi.fn((url: string, key: string, options?: unknown) => ({
  key,
  options,
  url,
})));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
  SupabaseClient: class SupabaseClient {},
}));

describe('server helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    createClientMock.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  it('reuses one service Supabase client per server runtime', async () => {
    const { createServiceClient } = await import('@/lib/server-helpers');

    const first = createServiceClient();
    const second = createServiceClient();

    expect(second).toBe(first);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledWith(
      'https://supabase.example.test',
      'service-role-key',
      {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
      }
    );
  });
});
