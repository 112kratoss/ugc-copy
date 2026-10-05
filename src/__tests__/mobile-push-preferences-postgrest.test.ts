import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/backend-rate-limit', async () => ({
  ...await vi.importActual<Record<string, unknown>>('@/lib/backend-rate-limit'), enforceBackendRateLimit: vi.fn(async () => ({})),
}));
import { ensureMobileNotificationPreferences } from '@/lib/mobile-notifications';
import { getMobileNotificationPreferencesForRoute, updateMobileNotificationPreferencesForRoute } from '@/lib/mobile-notification-preferences-service';
import { unregisterMobilePushTokenForRoute } from '@/lib/mobile-push-unregister-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('notification preferences and device retirement with actual identities', () => {
  let db: Client;
  let admin: SupabaseClient;
  let clients: SupabaseClient[];
  let owners: string[];
  let tokens: string[];
  let config: { API_URL: string; SERVICE_ROLE_KEY: string; ANON_KEY: string };
  const patch = (body: unknown) => updateMobileNotificationPreferencesForRoute({ userSupabase: clients[0], getAdminSupabase: () => admin, requestBody: body });
  const unregister = (body: unknown) => unregisterMobilePushTokenForRoute({ userSupabase: clients[0], getAdminSupabase: () => admin, requestBody: body });
  const rows = async () => (await db.query('select user_id,expo_push_token,device_id,is_active,disabled_at from public.mobile_push_tokens where user_id=any($1::uuid[]) order by expo_push_token', [owners])).rows;
  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    clients = []; owners = []; tokens = Array.from({ length: 3 }, () => `ExponentPushToken[audit_${randomUUID()}]`);
    for (let index = 0; index < 2; index++) {
      const email = randomUUID() + '@example.invalid', password = randomUUID() + 'aZ!7';
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(error).toBeNull(); owners.push(data.user!.id);
      const client = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull(); clients.push(client);
    }
    for (let index = 0; index < 3; index++) {
      expect((await admin.rpc('register_mobile_push_token', { p_user_id: owners[index === 2 ? 1 : 0], p_expo_push_token: tokens[index], p_platform: 'ios', p_device_id: 'device-' + index })).error).toBeNull();
    }
  });
  afterEach(async () => {
    await db.query('delete from auth.users where id=any($1::uuid[])', [owners]);
    expect(await rows()).toEqual([]);
  });
  it('initializes first-use preferences and preserves unrelated switches on a partial update', async () => {
    await db.query('delete from public.mobile_notification_preferences where user_id=$1', [owners[0]]);
    expect(await getMobileNotificationPreferencesForRoute({ userSupabase: clients[0] })).toMatchObject({ ok: true, body: { preferences: { pushEnabled: true, socialEnabled: true } } });
    expect(await patch({ pushEnabled: false, socialEnabled: false })).toMatchObject({ ok: true });
    expect(await patch({ generationEnabled: false })).toMatchObject({ ok: true, body: { preferences: { pushEnabled: false, socialEnabled: false, generationEnabled: false, commerceEnabled: true } } });
  });
  it('preserves both independent switches in concurrent partial updates', async () => {
    const result = await Promise.all([patch({ pushEnabled: false }), patch({ socialEnabled: false })]);
    expect(result.every(item => item.ok)).toBe(true);
    expect(await getMobileNotificationPreferencesForRoute({ userSupabase: clients[0] })).toMatchObject({ body: { preferences: { pushEnabled: false, socialEnabled: false } } });
  });
  it('does not reset a pause committed between a missing-row read and preference initialization', async () => {
    await db.query('delete from public.mobile_notification_preferences where user_id=$1', [owners[0]]);
    let observed!: () => void, release!: () => void;
    const read = new Promise<void>(resolve => { observed = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const gated = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === 'GET' && new URL(String(input)).pathname === '/rest/v1/mobile_notification_preferences') { observed(); await barrier; }
      return response;
    } } });
    const pending = ensureMobileNotificationPreferences(gated, owners[0]);
    try {
      await read;
      expect(await patch({ pushEnabled: false })).toMatchObject({ ok: true });
      release(); expect(await pending).toMatchObject({ pushEnabled: false });
    } finally { release(); await pending; }
  });
  it('binds preference writes to verified identity and hides another user through RLS', async () => {
    expect(await patch({ pushEnabled: false, userId: owners[1] })).toMatchObject({ ok: true });
    expect((await clients[0].from('mobile_notification_preferences').select('*').eq('user_id', owners[1])).data).toEqual([]);
    expect((await clients[0].from('mobile_notification_preferences').upsert({ user_id: owners[1], push_enabled: false })).error).not.toBeNull();
    expect((await db.query('select push_enabled from public.mobile_notification_preferences where user_id=$1', [owners[1]])).rows[0].push_enabled).toBe(true);
  });
  it('retires only the named token even when another device and allDevices are supplied', async () => {
    expect(await unregister({ expoPushToken: tokens[0], deviceId: 'device-1', allDevices: true })).toMatchObject({ ok: true });
    const state = await rows();
    expect(state.find(row => row.expo_push_token === tokens[0])?.is_active).toBe(false);
    expect(state.filter(row => row.is_active)).toHaveLength(2);
  });
  it('retires by device when token is absent and keeps the original retirement timestamp', async () => {
    expect(await unregister({ deviceId: 'device-0' })).toMatchObject({ ok: true });
    const first = (await rows()).find(row => row.expo_push_token === tokens[0]);
    expect(await unregister({ deviceId: 'device-0' })).toMatchObject({ ok: true });
    expect((await rows()).find(row => row.expo_push_token === tokens[0])).toEqual(first);
    expect(first?.disabled_at).toBeInstanceOf(Date);
    expect((await rows()).filter(row => row.is_active)).toHaveLength(2);
  });
  it('refuses all-device-only retirement and cannot retire another account token', async () => {
    expect(await unregister({ allDevices: true })).toMatchObject({ ok: false, status: 400 });
    expect(await unregister({ expoPushToken: tokens[2], userId: owners[1] })).toMatchObject({ ok: true });
    expect((await rows()).every(row => row.is_active)).toBe(true);
  });
});
