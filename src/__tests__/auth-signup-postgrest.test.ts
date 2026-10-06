// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isGeneratedProfileUsername, isClaimedProfileUsername } from '@/lib/profile';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('Auth signup through the actual profile trigger', () => {
  let admin: SupabaseClient;
  let guestClient: SupabaseClient;
  let db: Client;
  let ids: string[];
  const id = (prefix = randomUUID().slice(0, 8)) => {
    const next = prefix + randomUUID().slice(8);
    ids.push(next);
    return next;
  };
  const signup = (userId: string) => admin.auth.admin.createUser({
    id: userId, email: userId + '@audit.invalid', password: randomUUID(), email_confirm: true,
  });
  const profile = async (userId: string) => (await db.query(
    'select id,username,credits,promotional_credits from public.profiles where id=$1', [userId],
  )).rows[0];
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['127.0.0.1', 'localhost']).toContain(new URL(config.API_URL).hostname);
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    guestClient = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  beforeEach(() => { ids = []; });
  afterEach(async () => {
    for (const userId of ids) {
      if ((await db.query('select id from auth.users where id=$1', [userId])).rows.length) {
        expect((await admin.auth.admin.deleteUser(userId)).error).toBeNull();
      }
    }
    expect((await db.query('select id from auth.users where id=any($1::uuid[])', [ids])).rows).toEqual([]);
    expect((await db.query('select id from public.profiles where id=any($1::uuid[])', [ids])).rows).toEqual([]);
  });
  afterAll(async () => { await db.end(); });

  it('preserves the default placeholder and zero starting balance without a collision', async () => {
    const userId = id();
    expect((await signup(userId)).error).toBeNull();
    expect(await profile(userId)).toMatchObject({ username: 'creator-' + userId.slice(0, 8), credits: 0, promotional_credits: 0 });
  });

  it('creates both distinct Auth identities when their UUID prefixes collide', async () => {
    const first = id(); const second = id(first.slice(0, 8));
    expect((await signup(first)).error).toBeNull();
    const before = await profile(first);
    expect((await signup(second)).error).toBeNull();
    expect(await profile(first)).toEqual(before);
    const created = await profile(second);
    expect(created.username).not.toBe(before.username);
    expect(isGeneratedProfileUsername(created.username)).toBe(true);
    expect(isClaimedProfileUsername(created.username)).toBe(false);
    expect(created).toMatchObject({ credits: 0, promotional_credits: 0 });
    await db.query('update public.profiles set display_name=$1 where id=$2', ['Collision Fixture', second]);
    const grant = await admin.rpc('claim_credit_grant_program', {
      p_user_id: second, p_program_key: 'welcome_credits_v1', p_source_surface: 'web',
      p_identity_fingerprints: [randomUUID().replaceAll('-', '').repeat(2)],
    });
    expect(grant.error).toBeNull();
    expect(grant.data).toMatchObject({ status: 'not_eligible' });
    expect(await profile(second)).toMatchObject({ credits: 0, promotional_credits: 0 });
  });

  it('respects an existing placeholder assigned to another UUID without changing its owner', async () => {
    const first = id(); const second = id();
    expect((await signup(first)).error).toBeNull();
    await db.query('update public.profiles set username=$1 where id=$2', ['creator-' + second.slice(0, 8), first]);
    const before = await profile(first);
    expect((await signup(second)).error).toBeNull();
    expect(await profile(first)).toEqual(before);
    expect((await profile(second)).username.toLowerCase()).not.toBe(before.username.toLowerCase());
  });

  it('serializes concurrent signups competing for the same placeholder', async () => {
    const prefix = randomUUID().slice(0, 8);
    const users = Array.from({ length: 8 }, () => id(prefix));
    const results = await Promise.all(users.map(signup));
    expect(results.map(result => result.error)).toEqual(users.map(() => null));
    const profiles = (await db.query('select username,credits,promotional_credits from public.profiles where id=any($1::uuid[])', [users])).rows;
    expect(profiles).toHaveLength(8);
    expect(new Set(profiles.map(row => row.username.toLowerCase())).size).toBe(8);
    expect(profiles.filter(row => row.username === 'creator-' + prefix)).toHaveLength(1);
    expect(profiles.every(row => isGeneratedProfileUsername(row.username) && row.credits === 0 && row.promotional_credits === 0)).toBe(true);
  });

  it('keeps an anonymous collision profile as an unclaimed zero-credit identity', async () => {
    const first = id(); const guest = id(first.slice(0, 8));
    expect((await signup(first)).error).toBeNull();
    const source = await guestClient.auth.signInAnonymously();
    if (source.data.user) ids.push(source.data.user.id);
    expect(source.error).toBeNull();
    // Public anonymous signup chooses its own UUID. Clone its valid Auth row
    // to force the collision at the trigger, then read it through GoTrue.
    const columns = (await db.query("select attname from pg_attribute where attrelid='auth.users'::regclass and attnum>0 and not attisdropped and attgenerated='' order by attnum")).rows.map(row => row.attname as string);
    const quote = (column: string) => '"' + column.replaceAll('"', '""') + '"';
    await db.query(`insert into auth.users (${columns.map(quote).join(',')}) select ${columns.map(column => column === 'id' ? '$1::uuid' : quote(column)).join(',')} from auth.users where id=$2`, [guest, source.data.user!.id]);
    const result = await admin.auth.admin.getUserById(guest);
    expect(result.error).toBeNull(); expect(result.data.user?.is_anonymous).toBe(true);
    const created = await profile(guest);
    expect(isGeneratedProfileUsername(created.username)).toBe(true);
    expect(created).toMatchObject({ credits: 0, promotional_credits: 0 });
  });

  it('preserves actual public anonymous signup with a zero-credit generated profile', async () => {
    const result = await guestClient.auth.signInAnonymously();
    if (result.data.user) ids.push(result.data.user.id);
    expect(result.error).toBeNull();
    expect(result.data.user?.is_anonymous).toBe(true);
    const created = await profile(result.data.user!.id);
    expect(isGeneratedProfileUsername(created.username)).toBe(true);
    expect(created).toMatchObject({ credits: 0, promotional_credits: 0 });
  });
});
