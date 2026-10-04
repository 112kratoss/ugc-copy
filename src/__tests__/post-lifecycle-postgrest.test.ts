import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/showcase-feed-cache', () => ({ invalidateShowcaseFeedCache: vi.fn() }));
import { archiveOwnerPostForRoute, restoreOwnerPostForRoute } from '@/lib/post-lifecycle-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('post lifecycle through actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let config: { API_URL: string; SERVICE_ROLE_KEY: string };
  let owner: string;
  let other: string;
  let postId: string;
  let bundleId: string;
  const archive = (client = admin, user = owner) => archiveOwnerPostForRoute({ adminSupabase: client, ownerUserId: user, postId });
  const restore = (user = owner) => restoreOwnerPostForRoute({ adminSupabase: admin, ownerUserId: user, postId });
  const state = async () => (await db.query('select p.archived_at,b.status from public.posts p join public.post_resource_bundles b on b.post_id=p.id where p.id=$1', [postId])).rows[0];

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
    [owner, other, postId, bundleId] = Array.from({ length: 4 }, () => randomUUID());
    for (const id of [owner, other]) await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [id, `${id}@example.invalid`]);
    await db.query("update public.profiles set username=$1,display_name='Audit creator' where id=$2", ['audit-' + owner.slice(0, 8), owner]);
    await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,review_status,post_format,title,body) values($1,$2,'public','text','external','visible','text','Audit recipe fixture','A body long enough to read as real public content.')", [postId, owner]);
    await db.query("insert into public.post_resource_bundles(id,post_id,owner_user_id,access_mode,status,title,summary,preview_text,prompt_text,price_usd_cents) values($1,$2,$3,'free','published','Audit recipe','Anyone can use this recipe.','A preview long enough to satisfy the marketplace quality gate.','A free prompt that is long enough to count as a real resource.',0)", [bundleId, postId, owner]);
    expect((await db.query('select public.post_resource_bundle_quality_issue_for($1) issue', [bundleId])).rows[0].issue).toBeNull();
  });
  afterEach(async () => {
    await db.query('delete from public.posts where id=$1', [postId]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [[owner, other]]);
    await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [[owner, other]]);
    expect((await db.query('select id from auth.users where id=any($1::uuid[])', [[owner, other]])).rows).toHaveLength(0);
  });

  it('archives and restores the post and recipe together', async () => {
    expect(await archive()).toMatchObject({ ok: true });
    expect(await state()).toMatchObject({ archived_at: expect.any(Date), status: 'draft' });
    expect(await restore()).toMatchObject({ ok: true });
    expect(await state()).toEqual({ archived_at: null, status: 'published' });
  });

  it('denies foreign archive and restore without changing either row', async () => {
    expect(await archive(admin, other)).toMatchObject({ ok: false, status: 404 });
    expect(await state()).toEqual({ archived_at: null, status: 'published' });
    expect(await archive()).toMatchObject({ ok: true });
    expect(await restore(other)).toMatchObject({ ok: false, status: 404 });
    expect(await state()).toMatchObject({ archived_at: expect.any(Date), status: 'draft' });
  });

  it.each(['free', 'paid'] as const)('keeps a restored %s recipe published when the older archive response resumes', async (accessMode) => {
    if (accessMode === 'paid') await db.query("update public.post_resource_bundles set access_mode='paid',price_usd_cents=500 where id=$1", [bundleId]);
    let restored = false;
    const client = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: { fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === 'PATCH' && new URL(String(input)).pathname === '/rest/v1/posts') {
          expect(response.ok).toBe(true);
          // The archive transaction has committed, but its response is delayed.
          // Another request restores it before the older service resumes.
          expect(await state()).toMatchObject({ status: 'draft' });
          expect(await restore()).toMatchObject({ ok: true });
          expect(await state()).toEqual({ archived_at: null, status: 'published' });
          restored = true;
        }
        return response;
      } },
    });
    expect(await archive(client)).toMatchObject({ ok: true });
    expect(restored).toBe(true);
    expect(await state()).toEqual({ archived_at: null, status: 'published' });
  });
});
