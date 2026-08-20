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

  it('keeps generic signing restricted to legacy generated-media buckets', async () => {
    const { resolveStoredMediaUrl } = await import('@/lib/server-helpers');
    const createSignedUrl = vi.fn(async (filePath: string) => ({
      data: { signedUrl: `https://signed.example.test/${filePath}` },
      error: null,
    }));
    const from = vi.fn(() => ({ createSignedUrl }));
    const admin = { storage: { from } } as never;

    await expect(resolveStoredMediaUrl(
      admin,
      'generated_images/user-1/output.png',
    )).resolves.toBe('https://signed.example.test/user-1/output.png');
    expect(from).toHaveBeenCalledWith('generated_images');
    expect(createSignedUrl).toHaveBeenCalledWith('user-1/output.png', 3600);

    for (const path of [
      'uploads/user-1/private.png',
      'profiles/user-1/avatar.png',
      'post_resource_files/user-1/private.zip',
      'template_inputs/user-1/private.png',
      'template_assets/template-1/version-1/private.png',
    ]) {
      from.mockClear();
      createSignedUrl.mockClear();
      await expect(resolveStoredMediaUrl(admin, path)).resolves.toBe(path);
      expect(from).not.toHaveBeenCalled();
      expect(createSignedUrl).not.toHaveBeenCalled();
    }
  });
});
