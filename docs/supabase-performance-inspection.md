# Supabase performance inspection

This workflow captures the database evidence required before changing indexes,
timeouts, pooling or capacity claims. It uses the Supabase CLI's read-only
inspection commands plus application-specific, non-executing `EXPLAIN` plans.
It does not add a monitoring service or subscription.

## Local inspection

Start the existing local stack and replay migrations first:

```bash
supabase start
supabase db reset --local --no-seed --yes
npm run db:inspect:performance
```

The command writes an ignored, timestamped bundle under
`certification-artifacts/`. It captures database/table/index statistics,
read/write traffic, frequently called and expensive statements, blocking and
locks, long-running queries, bloat, vacuum state, roles and replication slots.
`application-hot-paths.json` adds:

- `backend_rate_limits` rows, bytes, scopes and matching `pg_stat_statements`;
- current waiting-session evidence;
- safe `EXPLAIN` plans for rate-limit retention, upload reclaim and exact upload
  admission counters.

With the repository-pinned Supabase CLI 2.75.0, `role-stats` may fail against
the local Postgres 17 image when a nullable field is returned. The workflow
preserves that CLI output and records equivalent role/connection evidence in
`application-hot-paths.json`; this known CLI defect does not discard the rest
of the inspection.

The plans intentionally omit `ANALYZE`: PostgreSQL plans the statements without
executing them, which is required for mutation-adjacent inspection.

For the destructive disposable-database benchmark, use:

```bash
npm run db:benchmark:scaling
```

It refuses any host except local Supabase on port 54322, truncates only the
local upload-reservation/counter and backend-rate-limit fixture tables, and
tests 10k, 100k and 1m rows. At each tier it drives five rounds of 50 concurrent
upload-admission calls and five rounds of 50 concurrent public-read limiter
calls, records latency/WAL/lock waits, and requires exact counter
reconciliation. Run `supabase db reset --local --no-seed --yes` afterward to
restore a clean database.

## Isolated remote branch

Use only a percent-encoded PostgreSQL URL for an isolated Supabase branch:

```bash
npm run db:inspect:performance -- --db-url "$CERT_DATABASE_URL" \
  --out certification-artifacts/isolated-branch-inspection
```

Never commit the URL or generated raw evidence. Tie the bundle to the exact
commit, schema fingerprint, fixture tier and workload. A diagnostic snapshot is
not a capacity certificate; measure P95/P99 latency, throughput, errors, WAL,
locks and drain behavior under the declared workload before publishing an MAU
claim.

## Interpretation rules

- Use calls/outliers and actual workload evidence before adding an index.
- Treat zero-scan indexes as review candidates, not automatic deletion targets.
- Require cache-hit, lock and vacuum evidence alongside query latency.
- Keep PostgreSQL public-read limiter work inside the origin write budget.
- Reset `pg_stat_statements` only at a declared workload boundary and record the
  reset in the artifact; never reset production statistics merely to tidy the
  report.
