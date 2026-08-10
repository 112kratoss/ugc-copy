#!/usr/bin/env node
/**
 * Phase 1 certification fixture seeder.
 *
 * Seeds a production-shaped catalog into an ISOLATED Supabase branch. Refuses to
 * run against the production project ref — this script writes millions of rows
 * and must never be pointed at production by accident.
 *
 * Sizing is derived, not chosen:
 *
 * - The user pool comes from the per-identity rate limits, not from taste. The
 *   for-you feed allows 60 reads per 10 minutes per identity (0.1 RPS/user), so
 *   sustaining 100 RPS of ranked reads needs ~300 users at 100% of the limit.
 *   The default pool is 2,000 so the run measures the application rather than
 *   `check_backend_rate_limit`.
 * - Post count drives F5's ranking cost and F7b's facts-per-session, which the
 *   audit measured at 26-32 only because production has ~34 posts and the
 *   candidate pool caps at 60. A real catalog pushes that toward the served
 *   slice bound, which is the number the 5,000 MAU gate actually rests on.
 *
 * Usage:
 *   node scripts/certification/seed-fixtures.mjs --tier 100k
 *   node scripts/certification/seed-fixtures.mjs --tier 1m --users 3000
 *   node scripts/certification/seed-fixtures.mjs --tier 1m --only bundles,facts
 */

import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { pathToFileURL } from 'node:url';

const { Client: PgClient } = pg;

const PRODUCTION_PROJECT_REF = 'ildfmhozpibwiopeavfg';

/** Row targets per tier. `posts` is the catalog; `facts` is the telemetry mass. */
const TIERS = {
  '10k': { posts: 2_000, facts: 10_000, bundles: 500, comments: 2_000 },
  '100k': { posts: 20_000, facts: 100_000, bundles: 5_000, comments: 20_000 },
  '1m': { posts: 200_000, facts: 1_000_000, bundles: 80_000, comments: 200_000 },
};

const SEED_PASSWORD = 'cert-load-test-password';
const SEED_EMAIL_DOMAIN = 'cert.invalid';
const SEED_COMPONENTS = ['users', 'posts', 'comments', 'bundles', 'facts'];
export const CERTIFICATION_BUNDLE_BATCH_SIZE = 1_000;
export const CERTIFICATION_FACT_SESSION_BATCH_SIZE = 500;
const FACTS_PER_SESSION = 30;

export function deriveFactResumePlan({ factCount, existingFacts, existingItems, existingSessions }) {
  const sessionCount = Math.ceil(factCount / FACTS_PER_SESSION);
  const expectedFacts = sessionCount * FACTS_PER_SESSION;
  if (existingFacts !== existingItems) {
    throw new Error(`Fact resume mismatch: ${existingFacts} facts but ${existingItems} session items.`);
  }
  if (existingFacts > expectedFacts || existingFacts % FACTS_PER_SESSION !== 0) {
    throw new Error(`Fact resume is not on a ${FACTS_PER_SESSION}-row session boundary: ${existingFacts}/${expectedFacts}.`);
  }
  if (existingSessions !== 0 && existingSessions !== sessionCount) {
    throw new Error(`Fact resume has ${existingSessions} sessions; expected 0 or ${sessionCount}.`);
  }
  if (existingFacts > 0 && existingSessions !== sessionCount) {
    throw new Error('Fact resume has committed facts without the complete pre-created session set.');
  }
  return {
    sessionCount,
    expectedFacts,
    startSessionOffset: existingFacts / FACTS_PER_SESSION,
    createSessions: existingSessions === 0,
    complete: existingFacts === expectedFacts,
  };
}

export function parseArgs(argv) {
  const options = { tier: '100k', users: 2_000, only: [...SEED_COMPONENTS] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--tier') {
      if (!TIERS[value]) throw new Error(`--tier must be one of ${Object.keys(TIERS).join(', ')}`);
      options.tier = value;
      index += 1;
    } else if (argument === '--users') {
      options.users = Number(value);
      if (!Number.isInteger(options.users) || options.users <= 0) throw new Error('--users must be a positive integer');
      index += 1;
    } else if (argument === '--only') {
      const components = String(value ?? '')
        .split(',')
        .map((component) => component.trim())
        .filter(Boolean);
      const invalid = components.filter((component) => !SEED_COMPONENTS.includes(component));
      if (components.length === 0 || invalid.length > 0) {
        throw new Error(`--only must contain one or more of ${SEED_COMPONENTS.join(', ')}`);
      }
      options.only = [...new Set(components)];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function requireEnvironment() {
  const url = process.env.CERT_SUPABASE_URL;
  const serviceRoleKey = process.env.CERT_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('CERT_SUPABASE_URL and CERT_SUPABASE_SERVICE_ROLE_KEY are required.');
  }

  // The single most important guard in this file.
  if (url.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error(
      `Refusing to seed: CERT_SUPABASE_URL points at the production project (${PRODUCTION_PROJECT_REF}).`,
    );
  }

  return { url, serviceRoleKey };
}

/**
 * Runs a statement through the branch's SQL endpoint. Seeding is bulk DML that
 * PostgREST cannot express efficiently, so this goes through a helper function
 * created at setup rather than through the REST API row-by-row.
 */
async function runSql(client, sql) {
  const { data, error } = await client.rpc('cert_exec_sql', { p_sql: sql });
  if (error) throw new Error(`SQL failed: ${error.message}\n--- statement ---\n${sql.slice(0, 400)}`);
  return data;
}

async function exactTableCount(client, table) {
  const { count, error } = await client.from(table).select('*', { count: 'exact', head: true });
  if (error || count === null) {
    throw new Error(`Could not count ${table}: ${error?.message ?? 'missing exact count'}`);
  }
  return count;
}

async function ensureFactPostOrdinals(client) {
  await runSql(client, `
    create unlogged table if not exists public.cert_fixture_post_ordinals (
      post_index bigint primary key,
      id uuid not null,
      user_id uuid not null
    );
    do $$
    declare
      fixture_count bigint;
      post_count bigint;
    begin
      select count(*) into fixture_count from public.cert_fixture_post_ordinals;
      select count(*) into post_count from public.posts;
      if fixture_count <> post_count then
        truncate public.cert_fixture_post_ordinals;
        insert into public.cert_fixture_post_ordinals (post_index, id, user_id)
        select (row_number() over (order by id)) - 1, id, user_id
        from public.posts
        order by id;
      end if;
    end $$;
    analyze public.cert_fixture_post_ordinals;
  `);
}

async function dropFactPostOrdinals(client) {
  await runSql(client, 'drop table if exists public.cert_fixture_post_ordinals;');
}

async function installSqlHelper(url, serviceRoleKey) {
  // Prefer the already-installed helper, but bootstrap a complete, versioned
  // helper set through a direct branch connection when this is a clean branch.
  // PostgREST cannot create the first RPC through an RPC that does not exist.
  const response = await fetch(`${url}/rest/v1/rpc/certification_helper_version`, {
    method: 'POST',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (response.ok && Number(await response.json()) >= 2) return;

  const databaseUrl = process.env.CERT_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Clean certification setup requires CERT_DATABASE_URL for the isolated branch.');
  }
  if (databaseUrl.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error('Refusing to install certification helpers on production.');
  }

  const client = new PgClient({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(`
      create or replace function public.certification_helper_version()
      returns integer language sql immutable as $$ select 2 $$;

      create or replace function public.cert_exec_sql(p_sql text)
      returns void language plpgsql security definer set search_path = public, pg_temp
      as $$ begin execute p_sql; end; $$;

      create or replace function public.cert_query(p_sql text)
      returns setof jsonb language plpgsql security definer set search_path = public, pg_temp
      as $$
      begin
        return query execute format(
          'select to_jsonb(cert_row) from (%s) cert_row',
          regexp_replace(p_sql, ';[[:space:]]*$', '')
        );
      end;
      $$;

      create or replace function public.cert_table_sizes()
      returns table(table_name text, row_estimate bigint, total_bytes bigint)
      language sql security definer set search_path = public, pg_temp
      as $$
        select c.relname::text, greatest(c.reltuples, 0)::bigint,
               pg_total_relation_size(c.oid)::bigint
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by pg_total_relation_size(c.oid) desc;
      $$;

      revoke all on function public.certification_helper_version() from public, anon, authenticated;
      revoke all on function public.cert_exec_sql(text) from public, anon, authenticated;
      revoke all on function public.cert_query(text) from public, anon, authenticated;
      revoke all on function public.cert_table_sizes() from public, anon, authenticated;
      grant execute on function public.certification_helper_version() to service_role;
      grant execute on function public.cert_exec_sql(text) to service_role;
      grant execute on function public.cert_query(text) to service_role;
      grant execute on function public.cert_table_sizes() to service_role;
      notify pgrst, 'reload schema';
    `);
  } finally {
    await client.end();
  }

  // `NOTIFY pgrst` is asynchronous. Do not race the first bulk seed against
  // schema-cache reload and misreport a clean branch as missing its helper.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = await fetch(`${url}/rest/v1/rpc/certification_helper_version`, {
      method: 'POST',
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => null);
    if (probe?.ok && Number(await probe.json()) >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Certification helpers were installed, but PostgREST did not reload them within 10 seconds.');
}

/**
 * Auth users are inserted directly rather than through the admin API: 2,000
 * sequential API calls take minutes, one statement takes a second. GoTrue signs
 * these in normally because every column it reads on the password grant is set.
 * The shared bcrypt hash is the same password for every seeded user.
 */
async function seedUsers(client, userCount) {
  console.log(`Seeding ${userCount} auth users...`);
  await runSql(client, `
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous,
      confirmation_token, recovery_token, email_change, email_change_token_new,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token
    )
    select
      '00000000-0000-0000-0000-000000000000'::uuid,
      gen_random_uuid(),
      'authenticated', 'authenticated',
      'cert-user-' || generation.index || '@${SEED_EMAIL_DOMAIN}',
      extensions.crypt('${SEED_PASSWORD}', extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb, false, false,
      -- GoTrue scans these into non-nullable Go strings. Left NULL, every sign-in
      -- fails with "Database error querying schema" and the whole authenticated
      -- workload silently becomes untestable.
      '', '', '', '', '', '', '', ''
    from generate_series(1, ${userCount}) as generation(index)
    on conflict do nothing;
  `);

  // Identities are what GoTrue's password grant actually looks up.
  await runSql(client, `
    insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    select u.id::text, u.id,
           jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
           'email', now(), now()
    from auth.users u
    where u.email like 'cert-user-%@${SEED_EMAIL_DOMAIN}'
    on conflict do nothing;
  `);

  // A signup trigger already created a profile for each auth user with a
  // GENERATED handle (creator-xxxxxxxx) and no display name. Publishing
  // publicly requires a *claimed* handle plus a display name, so an upsert that
  // only refreshed credits left every seeded user unable to publish — the
  // publish family fails 100% and looks like an application fault.
  // `avatar_url` is not decoration. `getCreatorProfileReadiness` gates
  // `sellerReady` on a claimed handle AND a display name AND an avatar, and
  // `assessMarketplaceListingQuality` rejects any listing whose seller is not
  // sellerReady. Seeded without one, all 5,000 bundles are ineligible and
  // `/api/marketplace/resources` returns an empty page with `hasMore: true` —
  // so the marketplace family would score 200s while measuring nothing. Found
  // exactly that way: 0 of 25 rows survived the quality gate.
  await runSql(client, `
    insert into public.profiles (id, credits, created_at, display_name, username, avatar_url)
    select u.id, 100000, now(),
           'Cert User ' || row_number() over (order by u.email),
           'certuser' || row_number() over (order by u.email),
           'https://ingtmbfnyomyjlwfishq.supabase.co/storage/v1/object/public/avatars/cert/'
             || row_number() over (order by u.email) || '.jpg'
    from auth.users u
    where u.email like 'cert-user-%@${SEED_EMAIL_DOMAIN}'
    on conflict (id) do update set
      credits = excluded.credits,
      display_name = excluded.display_name,
      username = excluded.username,
      avatar_url = excluded.avatar_url;
  `);
}

/**
 * Posts carry the review/visibility columns the feed filters on, so a seeded
 * catalog that skips them ranks zero candidates and the whole run measures an
 * empty feed.
 */
async function seedPosts(client, postCount) {
  console.log(`Seeding ${postCount} posts...`);
  const batchSize = 50_000;
  for (let offset = 0; offset < postCount; offset += batchSize) {
    const size = Math.min(batchSize, postCount - offset);
    await runSql(client, `
      with numbered_authors as (
        select id, (row_number() over (order by id)) - 1 as author_index
        from public.profiles
      ),
      author_count as (select count(*)::bigint as total from numbered_authors)
      -- Format mix mirrors a real feed rather than one shape: ~70% media,
      -- ~30% text. posts_public_surface_check ties format, category and the
      -- media columns together, so a uniform fixture is not insertable at all.
      insert into public.posts (
        id, user_id, visibility, category, title, description, prompt, source_kind,
        source_tool, created_at, updated_at, post_format, review_status, body,
        showcase_asset_path, save_count, remix_count, share_count, comment_count
      )
      select
        gen_random_uuid(),
        author.id,
        'public',
        case when shape.is_text then 'text'
             when shape.roll < 0.5 then 'image' else 'video' end,
        'Cert post ' || generation.index,
        'Seeded fixture for the Phase 1 certification load test.',
        'a cinematic product shot, studio lighting',
        'magicbooklet', 'kie',
        now() - (random() * interval '90 days'),
        now(),
        case when shape.is_text then 'text' else 'media' end,
        'visible',
        case when shape.is_text then 'Seeded certification text post ' || generation.index else null end,
        case when shape.is_text then null
             else 'showcase/cert/' || generation.index
                  || case when shape.roll < 0.5 then '.jpg' else '.mp4' end end,
        floor(random()*50)::int, floor(random()*10)::int,
        floor(random()*20)::int, floor(random()*15)::int
      from generate_series(${offset + 1}, ${offset + size}) as generation(index)
      -- Correlated by generation.index, for exactly the reason spelled out at
      -- the join below. An uncorrelated LATERAL is evaluated ONCE for the whole
      -- statement, so a bare "select random() < 0.3 as is_text" gives every post
      -- in the batch the same format — a 20,000-row catalog that is entirely
      -- video, or entirely text, with no mix for the feed to rank over. Measured
      -- on this branch before the fix: 10/10 posts came back video/media.
      -- The split is derived from the index rather than rolled so the catalog is
      -- reproducible: exactly 30% text, and the rest halved into image and video.
      cross join lateral (
        select (generation.index % 10) < 3 as is_text,
               case when (generation.index % 2) = 0 then 0.25 else 0.75 end as roll
      ) shape
      cross join author_count ac
      -- Authors are chosen by a prime stride over numbered profiles, which is
      -- genuinely correlated with the outer row. Neither a bare subquery nor a
      -- LATERAL that references no outer column works here: both are
      -- uncorrelated, Postgres evaluates them once for the whole statement, and
      -- all 20,000 posts end up owned by a single creator — which silently
      -- disables follow and flattens every creator-diversity term in the ranker.
      join numbered_authors author
        on author.author_index = (generation.index * 7919) % ac.total;
    `);
    console.log(`  posts: ${Math.min(offset + batchSize, postCount)}/${postCount}`);
  }
}

async function seedComments(client, commentCount) {
  console.log(`Seeding ${commentCount} comments...`);
  // Half land on one deterministic post. This makes the 100k tier contain a
  // 10k-comment thread and the 1m tier a 100k-comment thread, so F9's bounded
  // scan/index path is measured rather than inferred from many tiny threads.
  const hotThreadComments = Math.floor(commentCount / 2);
  const batchSize = 50_000;
  for (let offset = 0; offset < commentCount; offset += batchSize) {
    const size = Math.min(batchSize, commentCount - offset);
    await runSql(client, `
      with numbered_targets as (
        select id, (row_number() over (order by created_at, id)) - 1 as target_index
        from public.posts
      ),
      target_count as (select count(*)::bigint as total from numbered_targets),
      numbered_authors as (
        select id, (row_number() over (order by id)) - 1 as author_index
        from public.profiles
      ),
      author_count as (select count(*)::bigint as total from numbered_authors)
      insert into public.post_comments (id, post_id, user_id, body, status, reply_count, created_at, updated_at)
      select gen_random_uuid(), target.id, author.id,
             'Seeded certification comment ' || generation.index,
             'active', 0,
             now() - (random() * interval '60 days'), now()
      from generate_series(${offset + 1}, ${offset + size}) as generation(index)
      -- Correlated strides, for the same reason as posts: an uncorrelated
      -- subquery puts every comment on one post by one author.
      cross join target_count tc
      cross join author_count ac
      join numbered_targets target on target.target_index = case
        when generation.index <= ${hotThreadComments} then 0
        else (generation.index * 6151) % tc.total
      end
      join numbered_authors author on author.author_index = (generation.index * 7919) % ac.total;
    `);
  }
}

/**
 * Facts are the table the 5,000 MAU gate is derived from, and the one whose
 * retention sweep the cron-overlap case exercises. Spread across the retention
 * window so the prune has real work to do during the soak.
 */
async function seedFeedFacts(client, factCount) {
  const [existingFacts, existingItems, existingSessions] = await Promise.all([
    exactTableCount(client, 'feed_delivery_facts'),
    exactTableCount(client, 'feed_session_items'),
    exactTableCount(client, 'feed_sessions'),
  ]);
  const plan = deriveFactResumePlan({ factCount, existingFacts, existingItems, existingSessions });
  if (plan.complete) {
    console.log(`Feed delivery facts already complete (${existingFacts}/${plan.expectedFacts}); skipping.`);
    await dropFactPostOrdinals(client);
    return;
  }
  // Sessions are derived from the fact count, not from the user count. F7b
  // measured 26-32 facts per session in production, so a fixture with one
  // session per user would need hundreds of facts each and collide against
  // feed_session_items' UNIQUE (session_id, post_id) - a session ranks any
  // given post at most once.
  const sessionCount = plan.sessionCount;
  console.log(`Seeding ${factCount} feed delivery facts across ${sessionCount} sessions...`);
  if (plan.startSessionOffset > 0) {
    console.log(`  resuming facts at session ${plan.startSessionOffset}/${sessionCount}`);
  }
  // Build the 200k-post ordinal map once. Recomputing row_number() over the
  // full catalog in every fact batch spills temp files and exhausted the Micro
  // branch disk at 435k facts.
  await ensureFactPostOrdinals(client);

  if (plan.createSessions) await runSql(client, `
    with numbered_viewers as (
      select id, (row_number() over (order by id)) - 1 as viewer_index
      from public.profiles
    ),
    viewer_count as (select count(*)::bigint as total from numbered_viewers)
    insert into public.feed_sessions (
      id, viewer_user_id, surface, mode, algorithm_version_id,
      created_at, last_accessed_at, expires_at
    )
    select gen_random_uuid(), viewer.id, 'feed', 'for-you',
           (select id from public.feed_algorithm_versions order by created_at desc limit 1),
           now() - (random() * interval '25 days'), now(), now() + interval '1 day'
    from generate_series(1, ${sessionCount}) as generation(index)
    -- Correlated stride: sessions must spread across the user pool, not
    -- collapse onto one viewer, or every seeded fact is one person's history.
    cross join viewer_count vc
    join numbered_viewers viewer on viewer.viewer_index = (generation.index * 7919) % vc.total;
  `);

  // A fact's delivery_id IS a feed_session_items.id — the fact table mirrors
  // the session item it was served from, and `apply_feed_delivery_outcome`
  // joins on exactly that. Seeding facts with synthetic ids would produce a
  // fixture where no feed event can ever attach to its delivery, silently
  // disabling the hottest write path the soak is meant to exercise.
  // Posts are assigned to a session by a stride over a stable ordering rather
  // than at random, so the (session, post) pairs are unique by construction.
  const sessionBatch = CERTIFICATION_FACT_SESSION_BATCH_SIZE;
  for (let offset = plan.startSessionOffset; offset < sessionCount; offset += sessionBatch) {
    const size = Math.min(sessionBatch, sessionCount - offset);
    await runSql(client, `
      with numbered_sessions as (
        select id, viewer_user_id, algorithm_version_id,
               (row_number() over (order by id)) - 1 + ${offset} as session_index
        from (select id, viewer_user_id, algorithm_version_id from public.feed_sessions
              order by id limit ${size} offset ${offset}) batch
      ),
      catalog as (select count(*)::bigint as total from public.cert_fixture_post_ordinals),
      pairs as (
        select s.id as session_id, s.viewer_user_id, s.algorithm_version_id,
               p.id as post_id, p.user_id as creator_user_id,
               slot.position,
               (array['recency','affinity','exploration','trending'])[1 + floor(random()*4)::int] as candidate_source,
               now() - (random() * interval '25 days') as ranked_at
        from numbered_sessions s
        cross join catalog c
        cross join generate_series(0, ${FACTS_PER_SESSION - 1}) as slot(position)
        join public.cert_fixture_post_ordinals p
          on p.post_index = ((s.session_index * ${FACTS_PER_SESSION} + slot.position) % c.total)
      ),
      inserted_items as (
        insert into public.feed_session_items (
          session_id, post_id, position, candidate_source, final_score,
          score_components, is_exploration, ranked_at, served_at
        )
        select session_id, post_id, position, candidate_source, random(),
               jsonb_build_object('recency', random(), 'affinity', random(), 'engagement', random()),
               candidate_source = 'exploration', ranked_at, ranked_at
        from pairs
        returning id, session_id, post_id, position, candidate_source,
                  final_score, score_components, ranked_at, served_at
      )
      insert into public.feed_delivery_facts (
        delivery_id, session_id, algorithm_version_id, viewer_user_id, post_id,
        creator_user_id, position, candidate_source, final_score, score_components,
        surface, mode, ranked_at, served_at
      )
      select item.id, item.session_id, s.algorithm_version_id, s.viewer_user_id,
             item.post_id, p.user_id, item.position, item.candidate_source,
             item.final_score, item.score_components,
             'feed', 'for-you', item.ranked_at, item.served_at
      from inserted_items item
      join public.feed_sessions s on s.id = item.session_id
      join public.posts p on p.id = item.post_id;
    `);
    console.log(`  facts: ~${Math.min((offset + size) * FACTS_PER_SESSION, factCount)}/${factCount}`);
  }
  await dropFactPostOrdinals(client);
}

async function seedBundles(client, bundleCount) {
  console.log(`Seeding ${bundleCount} marketplace bundles...`);
  // F5b restructured this path against a seeded 80,000-bundle catalog; the
  // certification catalog has to reach that scale or it re-measures the old
  // small-catalog case that hid the problem.
  const existingBundles = await exactTableCount(client, 'post_resource_bundles');
  if (existingBundles > bundleCount) {
    throw new Error(`Fixture already has ${existingBundles} bundles; tier target is only ${bundleCount}.`);
  }
  if (existingBundles === bundleCount) {
    console.log(`Marketplace bundles already complete (${existingBundles}/${bundleCount}); skipping.`);
    return;
  }
  console.log(`  resuming at ${existingBundles}/${bundleCount}`);
  // Keep each statement below the branch gateway timeout. The previous 20k
  // batch completed at the 100k tier but timed out on the 1m fixture.
  const batchSize = CERTIFICATION_BUNDLE_BATCH_SIZE;
  for (let offset = existingBundles; offset < bundleCount; offset += batchSize) {
    const size = Math.min(batchSize, bundleCount - offset);
    await runSql(client, `
      insert into public.post_resource_bundles (
        id, post_id, owner_user_id, access_mode, status, title, summary,
        prompt_text, price_usd_cents, sales_count, created_at, updated_at
      )
      -- access_mode and price are constrained *together*: free must be exactly
      -- 0, paid must be >= 10 and a multiple of 10. Rolling them independently
      -- produces rows the table rejects.
      select gen_random_uuid(), p.id, p.user_id,
             case when pricing.is_paid then 'paid' else 'free' end,
             'published',
             'Cert bundle ' || generation.index,
             'Seeded certification bundle.',
             -- A published bundle must carry at least one unlock item; the
             -- prompt alone satisfies that without inventing attachment jsonb.
             'a cinematic product shot, studio lighting, 85mm',
             case when pricing.is_paid
                  then (array[500, 1200, 2900])[1 + floor(random()*3)::int]
                  else 0 end,
             floor(random()*100)::int, now(), now()
      -- post_id is UNIQUE on this table, so bundles are mapped onto distinct
      -- posts by offset rather than drawn at random, which collides.
      from (
        select id, user_id, row_number() over (order by created_at, id) as sequence
        from public.posts
        order by created_at, id
        limit ${size} offset ${offset}
      ) p
      cross join lateral (select ${offset} + p.sequence as index) generation
      -- Same uncorrelated-LATERAL trap as posts: "select random() < 0.5" with no
      -- outer reference makes every bundle in the batch free, or every one paid.
      -- Keyed off p.sequence instead, which alternates them exactly.
      cross join lateral (select (p.sequence % 2) = 0 as is_paid) pricing
      on conflict (post_id) do nothing;
    `);
    console.log(`  bundles: attempted ${Math.min(offset + batchSize, bundleCount)}/${bundleCount}`);
  }
}

async function reportSizes(client, url, serviceRoleKey) {
  const response = await fetch(`${url}/rest/v1/rpc/cert_table_sizes`, {
    method: 'POST',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (response.ok) console.log(await response.text());
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { url, serviceRoleKey } = requireEnvironment();
  const tier = TIERS[options.tier];

  console.log(`Seeding tier ${options.tier} into ${new URL(url).host}`);
  console.log(`  users ${options.users} · posts ${tier.posts} · facts ${tier.facts} · bundles ${tier.bundles}`);
  console.log(`  components ${options.only.join(', ')}`);

  const client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  await installSqlHelper(url, serviceRoleKey);

  const startedAt = Date.now();
  if (options.only.includes('users')) await seedUsers(client, options.users);
  if (options.only.includes('posts')) await seedPosts(client, tier.posts);
  if (options.only.includes('comments')) await seedComments(client, tier.comments);
  if (options.only.includes('bundles')) await seedBundles(client, tier.bundles);
  if (options.only.includes('facts')) await seedFeedFacts(client, tier.facts);
  await runSql(client, 'analyze;');
  await reportSizes(client, url, serviceRoleKey);

  console.log(`Seeded in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
