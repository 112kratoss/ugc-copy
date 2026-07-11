import { describe, expect, it, vi } from 'vitest';

import { resolveServerPostAuthPath } from '@/lib/auth-onboarding-server';

function createSupabaseProfileClient(profile: Record<string, unknown> | null, error: Error | null = null) {
  const maybeSingle = vi.fn(async () => ({ data: profile, error }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));

  return {
    client: { from },
    from,
    select,
    eq,
    maybeSingle,
  };
}

describe('server-side auth profile routing', () => {
  it('routes a ready returning user to their requested destination', async () => {
    const supabase = createSupabaseProfileClient({
      username: 'athul-creates',
      display_name: 'Athul Creates',
      bio: null,
      avatar_url: null,
      cover_url: null,
    });

    await expect(resolveServerPostAuthPath(
      supabase.client as never,
      'user-1',
      '/create/video?model=kling'
    )).resolves.toBe('/create/video?model=kling');
    expect(supabase.from).toHaveBeenCalledWith('profiles');
    expect(supabase.select).toHaveBeenCalledWith(
      'username, display_name, bio, avatar_url, cover_url'
    );
    expect(supabase.eq).toHaveBeenCalledWith('id', 'user-1');
  });

  it('routes a new or generated profile through setup without losing intent', async () => {
    const supabase = createSupabaseProfileClient({
      username: 'creator-a1b2c3d4',
      display_name: 'New creator',
      bio: null,
      avatar_url: null,
      cover_url: null,
    });

    await expect(resolveServerPostAuthPath(
      supabase.client as never,
      'user-1',
      '/create/image'
    )).resolves.toBe('/profile?welcome=1&next=%2Fcreate%2Fimage');
  });

  it('fails safely into setup if profile readiness cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const supabase = createSupabaseProfileClient(null, new Error('database unavailable'));

    await expect(resolveServerPostAuthPath(
      supabase.client as never,
      'user-1',
      '/create'
    )).resolves.toBe('/profile?welcome=1&next=%2Fcreate');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('sends recovery sessions directly to password reset without querying profile data', async () => {
    const supabase = createSupabaseProfileClient(null);

    await expect(resolveServerPostAuthPath(
      supabase.client as never,
      'user-1',
      '/auth/reset-password?next=%2Fcreate'
    )).resolves.toBe('/auth/reset-password?next=%2Fcreate');
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('honors a persisted onboarding skip without querying profile data', async () => {
    const supabase = createSupabaseProfileClient(null);

    await expect(resolveServerPostAuthPath(
      supabase.client as never,
      'user-1',
      '/create/video',
      { skipProfileOnboarding: true }
    )).resolves.toBe('/create/video');
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
