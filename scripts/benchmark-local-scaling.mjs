import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import pg from 'pg';

const { Client: PgClient } = pg;
const ALLOWED_TIERS = new Map([
  ['10k', 10_000],
  ['100k', 100_000],
  ['1m', 1_000_000],
]);
const RESERVED_BYTES = 250 * 1024 * 1024;
const FIXTURE_OWNER_ID = 'f0000000-0000-4000-8000-000000000001';

function workerUserId(ordinal) {
  const hex = crypto.createHash('md5').update(`local-scaling-user-${ordinal}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parsePositiveInteger(value, fallback, name, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    concurrency: 50,
    outputPath: null,
    rounds: 5,
    tiers: [...ALLOWED_TIERS.keys()],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--concurrency') {
      options.concurrency = parsePositiveInteger(argv[index + 1], 50, 'concurrency', 50);
      index += 1;
      continue;
    }
    if (value === '--rounds') {
      options.rounds = parsePositiveInteger(argv[index + 1], 5, 'rounds', 10);
      index += 1;
      continue;
    }
    if (value === '--tiers') {
      options.tiers = String(argv[index + 1] ?? '').split(',').filter(Boolean);
      index += 1;
      continue;
    }
    if (value === '--out') {
      options.outputPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${value}`);
  }
  if (!options.tiers.length || options.tiers.some((tier) => !ALLOWED_TIERS.has(tier))) {
    throw new Error('tiers must be a comma-separated subset of 10k,100k,1m.');
  }
  return options;
}

function localDatabaseUrl() {
  const output = execFileSync('supabase', ['status', '-o', 'env'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const match = output.match(/^DB_URL="([^"]+)"$/mu);
  if (!match) throw new Error('Could not resolve the local Supabase DB_URL.');
  const url = new URL(match[1]);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '54322') {
    throw new Error('Refusing to benchmark a database outside local Supabase on port 54322.');
  }
  return match[1];
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return Number(sorted[Math.min(index, sorted.length - 1)].toFixed(3));
}

function durationSummary(values) {
  return {
    count: values.length,
    minMs: values.length ? Number(Math.min(...values).toFixed(3)) : null,
    meanMs: values.length
      ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3))
      : null,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs: values.length ? Number(Math.max(...values).toFixed(3)) : null,
  };
}

async function ensureFixtureUsers(client, concurrency) {
  await client.query(`
    insert into auth.users (
      id, email, aud, role, raw_app_meta_data, raw_user_meta_data
    )
    select
      case when ordinal = 0
        then $1::uuid
        else md5('local-scaling-user-' || ordinal)::uuid
      end,
      'local-scaling-' || ordinal || '@example.invalid',
      'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
    from generate_series(0, $2::integer) as ordinal
    on conflict (id) do nothing
  `, [FIXTURE_OWNER_ID, concurrency]);
  await client.query(`
    insert into public.profiles (id, credits, identity_state)
    select id, 0, 'active'
    from auth.users
    where id = $1::uuid
       or email like 'local-scaling-%@example.invalid'
    on conflict (id) do update
      set identity_state = 'active', merged_into_user_id = null, merged_at = null
  `, [FIXTURE_OWNER_ID]);
}

async function seedTier(client, rowCount) {
  const startedAt = performance.now();
  await client.query('TRUNCATE public.backend_rate_limits');
  await client.query(`
    truncate public.upload_byte_reservations,
      public.upload_byte_user_counters,
      public.upload_byte_global_counters
  `);
  await client.query("SET session_replication_role = 'replica'");
  try {
    await client.query(`
      insert into public.upload_byte_reservations (
        id, user_id, bucket_id, storage_path, declared_bytes, reserved_bytes,
        expected_content_type, created_at, expires_at, released_at,
        finalization_status, issued_at, status_updated_at,
        legacy_compatibility_mode, reclaim_after
      )
      select
        md5('local-scaling-upload-' || ordinal)::uuid,
        $1::uuid,
        'uploads',
        $1 || '/fixture-' || ordinal || '.png',
        1,
        $2::bigint,
        'image/png',
        now() - interval '2 days',
        case when ordinal % 4 = 0 then now() - interval '1 day' else now() + interval '1 day' end,
        case when ordinal % 20 = 0 then now() else null end,
        case
          when ordinal % 20 = 0 then 'released'
          when ordinal % 20 < 14 then 'reserved'
          when ordinal % 20 < 16 then 'issued'
          when ordinal % 20 < 18 then 'finalized'
          else 'consumed'
        end,
        case when ordinal % 20 between 14 and 19 then now() - interval '1 hour' else null end,
        now() - interval '1 hour',
        false,
        case when ordinal % 40 = 0 then now() + interval '1 hour' else null end
      from generate_series(1, $3::integer) as ordinal
    `, [FIXTURE_OWNER_ID, RESERVED_BYTES, rowCount]);
  } finally {
    await client.query("SET session_replication_role = 'origin'");
  }
  await client.query(`
    insert into public.upload_byte_user_counters (user_id, outstanding_bytes, updated_at)
    select user_id, sum(reserved_bytes) filter (where released_at is null), now()
    from public.upload_byte_reservations
    group by user_id
  `);
  await client.query(`
    insert into public.upload_byte_global_counters (singleton, outstanding_bytes, updated_at)
    select true, coalesce(sum(reserved_bytes) filter (where released_at is null), 0), now()
    from public.upload_byte_reservations
  `);
  await client.query(`
    insert into public.backend_rate_limits (
      scope, subject_key, window_start, request_count, updated_at
    )
    select
      (array['showcase-feed:read', 'showcase-feed:for-you-read',
        'showcase-post:read', 'post-comments:read'])[(ordinal % 4) + 1],
      'fixture-subject-' || ordinal,
      date_trunc('hour', now()) - make_interval(hours => (ordinal % 48)::integer),
      (ordinal % 50) + 1,
      now() - make_interval(hours => (ordinal % 48)::integer)
    from generate_series(1, $1::integer) as ordinal
  `, [rowCount]);
  await client.query('ANALYZE public.upload_byte_reservations');
  await client.query('ANALYZE public.upload_byte_user_counters');
  await client.query('ANALYZE public.upload_byte_global_counters');
  await client.query('ANALYZE public.backend_rate_limits');
  return Number((performance.now() - startedAt).toFixed(3));
}

async function createWorkers(databaseUrl, concurrency) {
  const clients = await Promise.all(Array.from({ length: concurrency }, async () => {
    const client = new PgClient({ connectionString: databaseUrl });
    await client.connect();
    await client.query("SET statement_timeout = '10s'");
    return client;
  }));
  return clients;
}

async function sampleLockWaits(observer, stopSignal) {
  let maximum = 0;
  let samples = 0;
  while (!stopSignal.stopped) {
    const result = await observer.query(`
      select count(*)::integer as waits
      from pg_stat_activity
      where wait_event_type = 'Lock'
        and query ilike '%reserve_upload_bytes_v2%'
    `);
    maximum = Math.max(maximum, Number(result.rows[0]?.waits ?? 0));
    samples += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { maximum, samples };
}

async function runConcurrentWorkload({ clients, rounds, observer, operation }) {
  const durations = [];
  const failures = [];
  const stopSignal = { stopped: false };
  const sampler = sampleLockWaits(observer, stopSignal);
  const wallStartedAt = performance.now();
  try {
    for (let round = 0; round < rounds; round += 1) {
      const results = await Promise.all(clients.map(async (client, worker) => {
        const startedAt = performance.now();
        try {
          const result = await operation(client, worker, round);
          return { durationMs: performance.now() - startedAt, result };
        } catch (error) {
          return {
            durationMs: performance.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }));
      for (const result of results) {
        durations.push(result.durationMs);
        if (result.error) failures.push(result.error);
      }
    }
  } finally {
    stopSignal.stopped = true;
  }
  const locks = await sampler;
  return {
    durations: durationSummary(durations),
    failures,
    lockWaits: locks,
    wallMs: Number((performance.now() - wallStartedAt).toFixed(3)),
  };
}

async function walPosition(client) {
  const result = await client.query('select pg_current_wal_lsn()::text as lsn');
  return result.rows[0].lsn;
}

async function walBytesSince(client, startLsn) {
  const result = await client.query(
    'select pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::numeric as bytes',
    [startLsn],
  );
  return result.rows[0].bytes;
}

async function benchmarkTier({ client, databaseUrl, concurrency, rounds, tier, rowCount }) {
  console.log(`Seeding ${tier} upload and rate-limit rows...`);
  const seedMs = await seedTier(client, rowCount);
  const reconciliationBefore = await client.query(
    'select public.reconcile_upload_byte_admission_counters(false) as result',
  );
  const workers = await createWorkers(databaseUrl, concurrency);
  const observer = new PgClient({ connectionString: databaseUrl });
  await observer.connect();
  try {
    const uploadWalStart = await walPosition(client);
    const upload = await runConcurrentWorkload({
      clients: workers,
      rounds,
      observer,
      operation: async (workerClient, worker, round) => {
        const userId = workerUserId(worker + 1);
        const uploadId = crypto.randomUUID();
        const result = await workerClient.query(`
          select public.reserve_upload_bytes_v2(
            $1::uuid, $2::uuid, 'uploads', $3,
            1, $4::bigint, 'image/png',
            8000000000000000000::bigint,
            8000000000000000000::bigint,
            7200
          ) as result
        `, [uploadId, userId, `${userId}/benchmark-${tier}-${round}-${uploadId}.png`, RESERVED_BYTES]);
        if (result.rows[0]?.result?.reason !== 'reserved') {
          throw new Error(`Upload admission returned ${JSON.stringify(result.rows[0]?.result)}`);
        }
        return result.rows[0].result;
      },
    });
    upload.walBytes = await walBytesSince(client, uploadWalStart);

    const rateWalStart = await walPosition(client);
    const rateLimit = await runConcurrentWorkload({
      clients: workers,
      rounds,
      observer,
      operation: async (workerClient, worker) => {
        const result = await workerClient.query(`
          select public.check_backend_rate_limit(
            'showcase-feed:read', $1, 10000, 600
          ) as result
        `, [`benchmark-${tier}-${worker}`]);
        if (result.rows[0]?.result?.allowed !== true) {
          throw new Error(`Rate limit returned ${JSON.stringify(result.rows[0]?.result)}`);
        }
        return result.rows[0].result;
      },
    });
    rateLimit.walBytes = await walBytesSince(client, rateWalStart);

    const reconciliationAfter = await client.query(
      'select public.reconcile_upload_byte_admission_counters(false) as result',
    );
    const sizes = await client.query(`
      select
        (select count(*)::bigint from public.upload_byte_reservations) as upload_rows,
        pg_total_relation_size('public.upload_byte_reservations')::bigint as upload_bytes,
        (select count(*)::bigint from public.backend_rate_limits) as rate_limit_rows,
        pg_total_relation_size('public.backend_rate_limits')::bigint as rate_limit_bytes
    `);
    const passed = upload.failures.length === 0
      && rateLimit.failures.length === 0
      && reconciliationBefore.rows[0]?.result?.status === 'ok'
      && reconciliationAfter.rows[0]?.result?.status === 'ok'
      && upload.durations.p99Ms < 2_000
      && rateLimit.durations.p99Ms < 1_000;
    return {
      tier,
      fixtureRows: rowCount,
      seedMs,
      upload,
      rateLimit,
      reconciliationBefore: reconciliationBefore.rows[0]?.result,
      reconciliationAfter: reconciliationAfter.rows[0]?.result,
      sizes: sizes.rows[0],
      passed,
    };
  } finally {
    await Promise.all(workers.map((worker) => worker.end()));
    await observer.end();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = localDatabaseUrl();
  const client = new PgClient({ connectionString: databaseUrl });
  await client.connect();
  let results;
  try {
    const identity = await client.query(`
      select current_database() as database_name,
        inet_server_addr()::text as server_address,
        inet_server_port()::integer as server_port
    `);
    if (identity.rows[0]?.database_name !== 'postgres' || identity.rows[0]?.server_port !== 5432) {
      throw new Error('Local database identity check failed.');
    }
    await ensureFixtureUsers(client, options.concurrency);
    results = [];
    for (const tier of options.tiers) {
      results.push(await benchmarkTier({
        client,
        databaseUrl,
        concurrency: options.concurrency,
        rounds: options.rounds,
        tier,
        rowCount: ALLOWED_TIERS.get(tier),
      }));
    }
  } finally {
    await client.end();
  }

  const baseline = results[0];
  const largest = results.at(-1);
  const growth = {
    uploadP95Ratio: baseline.upload.durations.p95Ms > 0
      ? Number((largest.upload.durations.p95Ms / baseline.upload.durations.p95Ms).toFixed(3))
      : null,
    rateLimitP95Ratio: baseline.rateLimit.durations.p95Ms > 0
      ? Number((largest.rateLimit.durations.p95Ms / baseline.rateLimit.durations.p95Ms).toFixed(3))
      : null,
  };
  const passed = results.every((result) => result.passed)
    && (growth.uploadP95Ratio === null || growth.uploadP95Ratio <= 4)
    && (growth.rateLimitP95Ratio === null || growth.rateLimitP95Ratio <= 4);
  const report = {
    version: 1,
    capturedAt: new Date().toISOString(),
    target: 'local-supabase-only',
    concurrency: options.concurrency,
    rounds: options.rounds,
    operationsPerWorkloadPerTier: options.concurrency * options.rounds,
    tiers: results,
    largestToBaselineP95Growth: growth,
    passed,
    limitations: [
      'Direct local PostgreSQL function benchmark; excludes PostgREST, Auth, Storage API, CDN, network and Vercel.',
      'Fixture setup time is reported but is not an application-path SLO.',
      'A local pass is not a production or MAU capacity certificate.',
    ],
  };
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outputPath = path.resolve(
    options.outputPath ?? `certification-artifacts/local-database-scaling-${stamp}.json`,
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Local scaling benchmark written to ${outputPath}`);
  if (!passed) throw new Error('Local scaling benchmark failed its bounded verification gates.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
