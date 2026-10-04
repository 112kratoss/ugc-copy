import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { updateProfileForRoute } from '@/lib/profile-route-service';
import { validateProfileSubmission } from '@/lib/profile-server';
import { submitContactMessageForRoute } from '@/lib/contact-submission-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('profile and contact services with actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let config: { API_URL: string; SERVICE_ROLE_KEY: string };
  let owner: string;
  let other: string;
  let username: string;
  let email: string;
  const body = () => ({ username, displayName: 'Audit creator', bio: 'Fixture biography' });
  const update = (userId = owner, value: unknown = body(), client = admin) => updateProfileForRoute({
    userId, body: value, client, invalidateFeedCache: () => {},
  });
  const contact = (value: unknown = { name: ' Audit ', email: email.toUpperCase(), message: ' Test message ' }) => submitContactMessageForRoute({
    createAdminSupabase: () => admin, rateLimitKey: owner, readBody: async () => ({ ok: true, value }),
  });

  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    [owner, other] = [randomUUID(), randomUUID()];
    username = `audit-${owner.replaceAll('-', '').slice(0, 12)}`;
    email = `${owner}@example.invalid`;
    for (const id of [owner, other]) {
      await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [id, `${id}@example.invalid`]);
    }
  });
  afterEach(async () => {
    await db.query('delete from public.contact_messages where email=$1', [email]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [[owner, other]]);
    await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [[owner, other]]);
    expect((await db.query('select id from auth.users where id=any($1::uuid[])', [[owner, other]])).rows).toHaveLength(0);
  });

  it('binds profile updates to the caller and ignores injected balance or identity fields', async () => {
    const before = (await db.query('select credits,promotional_credits from public.profiles where id=$1', [owner])).rows[0];
    expect(await update(owner, { ...body(), id: other, credits: 999999, promotional_credits: 999999 })).toMatchObject({ ok: true });
    expect((await db.query('select username,display_name,credits,promotional_credits from public.profiles where id=$1', [owner])).rows[0])
      .toEqual({ username, display_name: 'Audit creator', ...before });
    expect((await db.query('select username from public.profiles where id=$1', [other])).rows[0].username).not.toBe(username);
  });

  it('validates username conflicts without modifying the other profile', async () => {
    expect(await update()).toMatchObject({ ok: true });
    expect(await validateProfileSubmission(admin, other, body())).toMatchObject({ ok: false, status: 409 });
    expect(await update(other)).toMatchObject({ ok: false, status: 409 });
  });

  it('returns one conflict when two profiles claim the same username concurrently', async () => {
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const client = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: { fetch: async (input, init) => {
        if (init?.method === 'POST' && String(input).includes('/rest/v1/profiles')) {
          if (++arrivals === 2) release();
          await barrier;
        }
        return fetch(input, init);
      } },
    });
    const results = await Promise.all([update(owner, body(), client), update(other, body(), client)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([expect.objectContaining({ status: 409 })]);
    expect((await db.query('select id from public.profiles where username=$1', [username])).rows).toHaveLength(1);
  });

  it('rejects invalid fields without persisting partial edits', async () => {
    expect(await update(owner, { ...body(), displayName: '', websiteUrl: 'javascript:alert(1)' })).toMatchObject({ ok: false, status: 400 });
    expect((await db.query('select username from public.profiles where id=$1', [owner])).rows[0].username).not.toBe(username);
  });

  it('stores a normalized contact message and default subject', async () => {
    expect(await contact()).toMatchObject({ ok: true });
    expect((await db.query('select name,email,subject,message from public.contact_messages where email=$1', [email])).rows)
      .toEqual([{ name: 'Audit', email, subject: 'general', message: 'Test message' }]);
  });

  it('rejects malformed/oversized contact fields before insertion', async () => {
    expect(await contact({ name: 'A', email: 'invalid', message: 'test' })).toMatchObject({ ok: false, status: 400 });
    expect(await contact({ name: 'A', email, message: 'x'.repeat(5001) })).toMatchObject({ ok: false, status: 400 });
    expect((await db.query('select id from public.contact_messages where email=$1', [email])).rows).toHaveLength(0);
  });

  it('enforces the persisted contact rate limit before reading another body', async () => {
    for (let i = 0; i < 10; i++) expect(await contact()).toMatchObject({ ok: true });
    let bodyRead = false;
    expect(await submitContactMessageForRoute({
      createAdminSupabase: () => admin, rateLimitKey: owner,
      readBody: async () => { bodyRead = true; return { ok: true, value: {} }; },
    })).toMatchObject({ ok: false, status: 429 });
    expect(bodyRead).toBe(false);
    expect((await db.query('select id from public.contact_messages where email=$1', [email])).rows).toHaveLength(10);
  });
});
