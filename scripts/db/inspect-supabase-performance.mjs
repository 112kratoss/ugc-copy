import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import pg from 'pg';

const { Client: PgClient } = pg;
const INSPECT_COMMANDS = [
  'db-stats',
  'table-stats',
  'index-stats',
  'traffic-profile',
  'calls',
  'outliers',
  'blocking',
  'locks',
  'long-running-queries',
  'bloat',
  'vacuum-stats',
  'role-stats',
  'replication-slots',
];
const OPTIONAL_INSPECT_COMMANDS = new Set([
  // CLI 2.75.0 cannot scan a nullable role field on the local Postgres 17
  // image. Equivalent role/connection evidence is captured through SQL below.
  'role-stats',
]);

function parseArgs(argv) {
  const options = { databaseUrl: null, outputDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db-url') {
      options.databaseUrl = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (value === '--out') {
      options.outputDirectory = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (value === '--local') continue;
    throw new Error(`Unknown option: ${value}`);
  }
  if (options.databaseUrl && !/^postgres(?:ql)?:\/\//u.test(options.databaseUrl)) {
    throw new Error('--db-url must be a PostgreSQL connection URL.');
  }
  return options;
}

function withoutAnsi(value) {
  return value.replace(/\u001B\[[0-9;]*m/gu, '');
}

function localDatabaseUrl() {
  const output = execFileSync('supabase', ['status', '-o', 'env'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const match = output.match(/^DB_URL="([^"]+)"$/mu);
  if (!match) throw new Error('Could not resolve the local Supabase DB_URL.');
  return match[1];
}

function safeOutputDirectory(requested) {
  if (requested) return path.resolve(requested);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return path.resolve('certification-artifacts', `supabase-inspection-${stamp}`);
}

function runInspectCommand(command, databaseUrl) {
  const connectionArgs = databaseUrl
    ? ['--db-url', databaseUrl]
    : ['--local'];
  const result = spawnSync('supabase', ['inspect', 'db', command, ...connectionArgs], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = withoutAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  return {
    command,
    exitCode: result.status ?? 1,
    output,
  };
}

async function collectApplicationEvidence(databaseUrl) {
  const remote = !/^(?:postgres(?:ql)?:\/\/)?(?:postgres(?::[^@]*)?@)?(?:127\.0\.0\.1|localhost)(?::|\/)/u
    .test(databaseUrl);
  const client = new PgClient({
    connectionString: databaseUrl,
    ...(remote ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '2s'");

    const metadata = await client.query(`
      select
        current_database() as database_name,
        current_setting('server_version') as server_version,
        current_setting('track_io_timing', true) as track_io_timing,
        pg_postmaster_start_time() as postmaster_started_at,
        now() as captured_at
    `);
    const rateLimitTable = await client.query(`
      select
        count(*)::bigint as live_rows,
        min(window_start) as oldest_window_start,
        max(updated_at) as newest_update_at,
        pg_total_relation_size('public.backend_rate_limits')::bigint as total_bytes,
        pg_indexes_size('public.backend_rate_limits')::bigint as index_bytes
      from public.backend_rate_limits
    `);
    const rateLimitScopes = await client.query(`
      select scope, count(*)::bigint as rows, sum(request_count)::bigint as requests
      from public.backend_rate_limits
      group by scope
      order by requests desc, scope
      limit 50
    `);
    const lockWaits = await client.query(`
      select
        wait_event_type,
        wait_event,
        state,
        count(*)::integer as sessions
      from pg_stat_activity
      where pid <> pg_backend_pid()
        and (wait_event is not null or state <> 'idle')
      group by wait_event_type, wait_event, state
      order by sessions desc, wait_event_type, wait_event
    `);
    const roleStats = await client.query(`
      select
        role.rolname as role_name,
        role.rolcanlogin as can_login,
        role.rolconnlimit as connection_limit,
        count(activity.pid)::integer as current_connections,
        count(activity.pid) filter (where activity.state = 'active')::integer as active_connections
      from pg_roles as role
      left join pg_stat_activity as activity on activity.usename = role.rolname
      where role.rolcanlogin or activity.pid is not null
      group by role.rolname, role.rolcanlogin, role.rolconnlimit
      order by current_connections desc, role.rolname
    `);
    const extension = await client.query(`
      select n.nspname as schema_name
      from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'pg_stat_statements'
    `);

    let rateLimitStatements = [];
    if (extension.rows[0]?.schema_name) {
      const schema = String(extension.rows[0].schema_name).replace(/"/gu, '""');
      const statements = await client.query(`
        select
          queryid::text,
          calls::bigint,
          round(total_exec_time::numeric, 3) as total_exec_ms,
          round(mean_exec_time::numeric, 3) as mean_exec_ms,
          rows::bigint,
          shared_blks_hit::bigint,
          shared_blks_read::bigint,
          wal_bytes::numeric,
          left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 500) as query
        from "${schema}".pg_stat_statements
        where query ilike '%check_backend_rate_limit%'
          and query not ilike '%pg_stat_statements%'
          and query not ilike '%create or replace function%'
          and query not ilike 'revoke %'
          and query not ilike 'grant %'
          and query not like '--%'
        order by total_exec_time desc
        limit 25
      `);
      rateLimitStatements = statements.rows;
    }

    const plans = {};
    for (const [name, sql] of Object.entries({
      rate_limit_expiry_lookup: `
        select 1
        from public.backend_rate_limits
        where scope = 'showcase-feed:read'
          and subject_key = 'inspection-subject'
          and window_start < now() - interval '1 day'
      `,
      upload_reclaim_candidates: `
        select id, expires_at
        from public.upload_byte_reservations
        where released_at is null
          and expires_at <= now()
          and (reclaim_after is null or reclaim_after <= now())
          and finalization_status in (
            'reserved', 'issued', 'finalizing', 'finalized',
            'consuming', 'consumed', 'deleted', 'reclaiming'
          )
        order by expires_at, id
        limit 500
      `,
      upload_admission_user_counter: `
        select outstanding_bytes
        from public.upload_byte_user_counters
        where user_id = '00000000-0000-4000-8000-000000000001'
      `,
      upload_admission_global_counter: `
        select outstanding_bytes
        from public.upload_byte_global_counters
        where singleton = true
      `,
    })) {
      const explained = await client.query(`EXPLAIN (FORMAT JSON, COSTS, SETTINGS) ${sql}`);
      plans[name] = explained.rows[0]?.['QUERY PLAN'] ?? null;
    }

    await client.query('COMMIT');
    return {
      metadata: metadata.rows[0],
      rateLimitTable: rateLimitTable.rows[0],
      rateLimitScopes: rateLimitScopes.rows,
      rateLimitStatements,
      lockWaits: lockWaits.rows,
      roleStats: roleStats.rows,
      plans,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDirectory = safeOutputDirectory(options.outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });

  const inspectResults = INSPECT_COMMANDS.map((command) => (
    runInspectCommand(command, options.databaseUrl)
  ));
  for (const result of inspectResults) {
    fs.writeFileSync(path.join(outputDirectory, `${result.command}.txt`), result.output);
  }

  const databaseUrl = options.databaseUrl ?? localDatabaseUrl();
  const applicationEvidence = await collectApplicationEvidence(databaseUrl);
  fs.writeFileSync(
    path.join(outputDirectory, 'application-hot-paths.json'),
    `${JSON.stringify(applicationEvidence, null, 2)}\n`,
  );

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = spawnSync('git', ['diff', '--quiet']).status !== 0
    || spawnSync('git', ['diff', '--cached', '--quiet']).status !== 0
    || Boolean(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim());
  const failedCommands = inspectResults.filter((result) => (
    result.exitCode !== 0 && !OPTIONAL_INSPECT_COMMANDS.has(result.command)
  ));
  const warningCommands = inspectResults.filter((result) => (
    result.exitCode !== 0 && OPTIONAL_INSPECT_COMMANDS.has(result.command)
  ));
  const summary = [
    '# Supabase performance inspection',
    '',
    `- Captured: ${new Date().toISOString()}`,
    `- Commit: \`${commit}\``,
    `- Working tree dirty: ${dirty ? 'yes' : 'no'}`,
    `- Target: ${options.databaseUrl ? 'explicit database URL (redacted)' : 'local Supabase'}`,
    `- Supabase inspect commands: ${inspectResults.length - failedCommands.length - warningCommands.length}/${inspectResults.length} passed`,
    `- CLI fallbacks: ${warningCommands.length ? warningCommands.map(({ command }) => command).join(', ') : 'none'}`,
    `- Application hot-path evidence: application-hot-paths.json`,
    '',
    'This snapshot is diagnostic evidence, not a capacity certificate. `EXPLAIN`',
    'plans do not use `ANALYZE`, so the inspection never executes mutations.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outputDirectory, 'README.md'), summary);

  if (failedCommands.length > 0) {
    throw new Error(`Supabase inspection failed: ${failedCommands.map(({ command }) => command).join(', ')}`);
  }
  console.log(`Supabase performance inspection written to ${outputDirectory}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
