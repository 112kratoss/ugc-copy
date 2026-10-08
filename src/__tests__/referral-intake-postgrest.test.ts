import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as overviewRoute } from '@/app/api/referrals/me/route';
import { POST as linkRoute } from '@/app/api/referrals/link/route';
import { POST as visitRoute } from '@/app/api/referrals/visit/route';
import { POST as claimRoute } from '@/app/api/referrals/claim/route';
import { getReferralRiskContext } from '@/lib/referral';
import { guardUserFacingRouteIdentity } from '@/lib/route-identity-admission';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;
// Run the production proxy's shared admission boundary and the actual route
// exports. This does not simulate Next's HTTP server, CORS or native deep links.
const admitted = (handler: (request: Request) => Promise<Response>) => async (request: Request) =>
  await guardUserFacingRouteIdentity(new NextRequest(request.url, { method: request.method, headers: request.headers })) ?? await handler(request);
const overview = admitted(overviewRoute), link = admitted(linkRoute), visit = admitted(visitRoute), claim = admitted(claimRoute);
const writeRoutes = [{ name: 'link', handler: link }, { name: 'visit', handler: visit }, { name: 'claim', handler: claim }];
const privateRoutes = [{ name: 'me', handler: overview }, ...writeRoutes.filter(route => route.name !== 'visit')];
type Actor = { id: string; token: string; client: SupabaseClient };

describe.skipIf(!configPath || !connectionString)('referral intake through actual Auth, PostgREST and SQL', () => {
  let db: Client, admin: SupabaseClient;
  let config: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
  let users: string[], codes: string[], rateKeys: string[];
  let inviter: Actor, network: string;
  const makeActor = async (): Promise<Actor> => {
    const email = `referral-intake-${randomUUID()}@example.invalid`, password = randomUUID() + 'aZ7!';
    const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(made.error).toBeNull();
    const id = made.data.user!.id; users.push(id);
    const client = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    expect(signed.error).toBeNull();
    return { id, token: signed.data.session!.access_token, client };
  };
  const request = (name: string, raw?: string, actor: Actor | null = inviter, cookie?: string) => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'x-vercel-forwarded-for': network });
    if (actor) headers.set('Authorization', `Bearer ${actor.token}`);
    if (cookie) headers.set('Cookie', cookie);
    rateKeys.push(getReferralRiskContext(headers).rateLimitKey);
    return new Request(`https://magicbooklet.local/api/referrals/${name}`, { method: name === 'me' ? 'GET' : 'POST', headers, ...(name === 'me' ? {} : { body: raw ?? '{}' }) });
  };
  const makeCode = async (actor = inviter) => {
    const response = await link(request('link', '{}', actor));
    expect(response.status).toBe(200);
    const body = await response.json(); codes.push(body.code);
    return body.code as string;
  };
  const makeVisit = async (code: string, source = 'web') => {
    const response = await visit(request('visit', JSON.stringify({ code, source }), null));
    expect(response.status).toBe(200);
    return await response.json() as { visitToken: string; code: string };
  };
  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY);
    vi.stubEnv('REFERRAL_ATTRIBUTION_HASH_SECRET', randomUUID());
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.origin !== new URL(config.API_URL).origin) throw Error('External network forbidden in local referral intake controls');
      return originalFetch(target, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    expect((await db.query("select id from public.referral_programs where status='active'")).rows).toHaveLength(1);
  });
  beforeEach(async () => {
    users = []; codes = []; rateKeys = []; network = 'audit-' + randomUUID();
    inviter = await makeActor();
  });
  afterEach(async () => {
    try {
      // Intake alone must never create monetary state.
      expect((await db.query('select id from public.referral_rewards where beneficiary_user_id=any($1::uuid[])', [users])).rows).toEqual([]);
      expect((await db.query('select id from public.transactions where user_id=any($1::uuid[])', [users])).rows).toEqual([]);
    } finally {
      await db.query('delete from public.referral_attributions where inviter_user_id=any($1::uuid[]) or invitee_user_id=any($1::uuid[])', [users]);
      await db.query('delete from public.referral_visits where inviter_user_id=any($1::uuid[])', [users]);
      await db.query('delete from public.referral_codes where user_id=any($1::uuid[]) or code=any($2::text[])', [users, codes]);
      await db.query('delete from auth.users where id=any($1::uuid[])', [users]);
      await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [[...users, ...rateKeys]]);
    }
    expect((await db.query(`select
      (select count(*) from auth.users where id=any($1::uuid[]))::int users,
      (select count(*) from public.referral_attributions where inviter_user_id=any($1::uuid[]) or invitee_user_id=any($1::uuid[]))::int attributions,
      (select count(*) from public.referral_visits where inviter_user_id=any($1::uuid[]))::int visits,
      (select count(*) from public.referral_codes where code=any($2::text[]))::int codes,
      (select count(*) from public.backend_rate_limits where subject_key=any($3::text[]))::int rates`, [users, codes, [...users, ...rateKeys]])).rows)
      .toEqual([{ users: 0, attributions: 0, visits: 0, codes: 0, rates: 0 }]);
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each(writeRoutes.flatMap(route => ['null', '[]', '5', 'true', '"scalar"', '{', ''].map(raw => ({ ...route, raw }))))('rejects malformed/nonobject root $raw at $name without mutation', async ({ name, handler, raw }) => {
    const response = await handler(request(name, raw));
    expect(response.status).toBe(400); expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await db.query('select id from public.referral_codes where user_id=$1', [inviter.id])).rows).toEqual([]);
    expect((await db.query('select id from public.referral_attributions where invitee_user_id=$1', [inviter.id])).rows).toEqual([]);
  });
  it.each(privateRoutes)('denies unsigned $name before state access', async ({ name, handler }) => {
    const response = await handler(request(name, '{}', null));
    expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each(privateRoutes)('denies a real guest at $name before referral mutation', async ({ name, handler }) => {
    const client = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = await client.auth.signInAnonymously(); expect(signed.error).toBeNull();
    const guest = { id: signed.data.user!.id, token: signed.data.session!.access_token, client }; users.push(guest.id);
    const response = await handler(request(name, '{}', guest)); expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'REGISTRATION_REQUIRED' });
    expect((await db.query('select id from public.referral_codes where user_id=$1', [guest.id])).rows).toEqual([]);
  });
  it.each(privateRoutes)('denies a revoked Auth session at $name', async ({ name, handler }) => {
    await db.query('delete from auth.sessions where user_id=$1', [inviter.id]);
    const response = await handler(request(name)); expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await db.query('select id from public.referral_codes where user_id=$1', [inviter.id])).rows).toEqual([]);
  });
  it.each(writeRoutes)('enforces the actual rate limit at $name with retry metadata', async ({ name, handler }) => {
    const code = await makeCode(), made = await makeVisit(code), buyer = await makeActor();
    const limit = name === 'link' ? 30 : name === 'visit' ? 60 : 20;
    const body = JSON.stringify({ code, source: 'web', visitToken: made.visitToken });
    // Separate actor/key so fixture setup does not consume the measured bucket.
    network = 'audit-' + randomUUID();
    for (let i = 0; i < limit; i++) expect((await handler(request(name, body, name === 'visit' ? null : buyer))).status).toBe(200);
    const response = await handler(request(name, body, name === 'visit' ? null : buyer));
    expect(response.status).toBe(429); expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(response.headers.get('X-RateLimit-Limit')).toBe(String(limit));
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('claims the web cookie token and safely rejects malformed cookie encoding', async () => {
    const code = await makeCode(), made = await makeVisit(code), buyer = await makeActor();
    const invalid = await claim(request('claim', '{}', buyer, 'mb_referral_visit=%E0%A4%A')); expect(invalid.status).toBe(400);
    const response = await claim(request('claim', '{}', buyer, `mb_referral_visit=${made.visitToken}`));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ claimed: true });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('allocates one code under concurrent link requests and ignores a supplied owner', async () => {
    const other = await makeActor();
    const responses = await Promise.all(Array.from({ length: 6 }, () => link(request('link', JSON.stringify({ userId: other.id, next: 'https://attacker.invalid' })))));
    const bodies = await Promise.all(responses.map(async response => { expect(response.status).toBe(200); return response.json(); }));
    codes.push(...bodies.map(body => body.code));
    expect(new Set(codes).size).toBe(1);
    expect(bodies.every(body => new URL(body.shareUrl).searchParams.get('next') === '/create')).toBe(true);
    expect((await db.query('select user_id from public.referral_codes where user_id=any($1::uuid[])', [users])).rows).toEqual([{ user_id: inviter.id }]);
  });
  it.each(['web', 'mobile'])('records a public %s visit and keeps first attribution on a later link', async source => {
    const firstCode = await makeCode(), other = await makeActor(), secondCode = await makeCode(other);
    const first = await makeVisit(firstCode, source);
    const response = await visit(request('visit', JSON.stringify({ code: secondCode, source, visitToken: first.visitToken, next: '//attacker.invalid' }), null));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: firstCode, visitToken: first.visitToken });
    expect(response.headers.get('set-cookie')?.includes('HttpOnly') ?? false).toBe(source === 'web');
    expect((await db.query('select channel,destination_path from public.referral_visits where inviter_user_id=any($1::uuid[])', [users])).rows)
      .toEqual([{ channel: source === 'web' ? 'web' : 'native', destination_path: '/create' }]);
  });
  it('claims for the authenticated new account, replays once, and scopes dashboard counts', async () => {
    const code = await makeCode(), made = await makeVisit(code), buyer = await makeActor(), other = await makeActor();
    const body = JSON.stringify({ visitToken: made.visitToken, userId: other.id });
    const first = await claim(request('claim', body, buyer)); expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ claimed: true }); expect(first.headers.get('set-cookie')).toContain('Max-Age=0');
    const replay = await claim(request('claim', body, buyer)); expect(await replay.json()).toMatchObject({ claimed: false, reason: 'already_attributed' });
    expect((await db.query('select inviter_user_id,invitee_user_id from public.referral_attributions where inviter_user_id=$1', [inviter.id])).rows)
      .toEqual([{ inviter_user_id: inviter.id, invitee_user_id: buyer.id }]);
    const own = await overview(request('me')); expect(own.status).toBe(200); expect(await own.json()).toMatchObject({ stats: { visits: 1, signups: 1, purchasers: 0 } });
    const unrelated = await overview(request('me', undefined, other)); expect(unrelated.status).toBe(200);
    const data = await unrelated.json(); codes.push(data.code); expect(data).toMatchObject({ stats: { visits: 0, signups: 0 } });
  });
  it.each(['self', 'existing', 'expired', 'disabled'])('does not attribute an ineligible %s claim', async mode => {
    const code = await makeCode(), existing = await makeActor(), made = await makeVisit(code);
    const buyer = mode === 'self' ? inviter : mode === 'existing' ? existing : await makeActor();
    if (mode === 'expired') await db.query("update public.referral_visits set visited_at=now()-interval '2 days',expires_at=now()-interval '1 day' where public_token=$1", [made.visitToken]);
    if (mode === 'disabled') await db.query("update public.referral_codes set is_enabled=false,disabled_reason='local audit' where code=$1", [code]);
    const response = await claim(request('claim', JSON.stringify({ visitToken: made.visitToken }), buyer)); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ claimed: false, reason: mode === 'self' ? 'self_referral' : mode === 'existing' ? 'existing_account' : 'visit_unavailable' });
    expect((await db.query('select id from public.referral_attributions where inviter_user_id=$1', [inviter.id])).rows).toEqual([]);
  });
  it('serializes competing account claims on one visit token', async () => {
    const code = await makeCode(), made = await makeVisit(code), buyers = [await makeActor(), await makeActor()];
    const results = await Promise.all(buyers.map(async buyer => {
      const response = await claim(request('claim', JSON.stringify({ visitToken: made.visitToken }), buyer));
      expect(response.status).toBe(200); return response.json();
    }));
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(results.filter(result => result.reason === 'visit_unavailable')).toHaveLength(1);
    expect((await db.query('select id from public.referral_attributions where inviter_user_id=$1', [inviter.id])).rows).toHaveLength(1);
  });
  it('denies direct authenticated privileged RPC calls and private referral reads', async () => {
    await makeCode();
    for (const [name, args] of [
      ['ensure_referral_code', { p_user_id: inviter.id }],
      ['get_referral_dashboard', { p_user_id: inviter.id }],
      ['create_referral_visit', { p_code: codes[0], p_channel: 'web' }],
      ['claim_referral_visit', { p_invitee_user_id: inviter.id, p_visit_token: randomUUID() }],
    ] as const) {
      const result = await inviter.client.rpc(name, args); expect(result.error?.code).toBe('42501');
    }
    const rows = await inviter.client.from('referral_codes').select('*');
    expect(rows.error?.code === '42501' || rows.data?.length === 0).toBe(true);
  });
});
