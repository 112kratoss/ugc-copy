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

With the dev-Mac Supabase CLI 2.75.0, `role-stats` may fail against
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

## Search query log

`public.search_query_events` records one row per first-page `/api/search` answer
(none for a later page or a 400, 401, 429 or 500), so search ranking can be tuned
against what people actually type and miss. The insert runs behind the response
(Next's `after`) and a failure is logged and dropped, never shown to the caller.
`SEARCH_QUERY_LOG_DISABLED=1` stops the writes.

A row holds no account id or address: the lowercased query (control characters
removed, at most 100 characters), the search type, whether a registered account
(not a guest session) was presented, how many creators, posts and recipes were
returned, the order a Posts or Recipes search asked for (`sort`: `top` or
`latest`; empty for Top and Creators searches, which have one order, and for
rows from before 2026-11-12), when the request arrived, and `visitor_day`. That is an HMAC of the
viewer's rate-limit key (user id or hashed network address, never stored) under a
random key made for that UTC day alone (`search_visitor_day_keys`). The sweep
deletes a key once its day is more than 48 hours old, so `visitor_day` is
pseudonymous for 48 hours to whoever holds the service role and cannot be
recomputed from an account or an address by anyone after that (operators
included); a visitor is never joined across days. If the key cannot be read the
row gets a random value instead and the answer is unaffected. Rows are kept 90
days by the operational retention sweep (`prune_operational_backend_data`, which
reports `search_query_events_deleted` and `search_visitor_day_keys_deleted`) and
`search_query_events` is watched by `get_operational_table_growth` (warning at
500,000 rows).

Search results are ranked in the database by `search_post_score` and
`search_creator_score` (`20261112103547`); retuning is a re-create of one of them.
After a code-only rollback to an app from before that migration, search keeps
working against it: Top is scored at the start of the UTC day, a Latest posts
cursor still open in a browser is a 400 ("Show more" fails once, a new search is
fine), and a Latest recipes cursor is read as an offset into the relevance order.

```bash
npm run ops:search-report -- --days 7 [--limit 50] [--json]
```

Read-only, service role. It prints, per final query, how many distinct
visitor-days searched it and how many of those found nothing in any kind, zero
results first, under a line with the window's totals and zero-result rate. A
"final query" is one that no later query of the same visitor-day extends within
15 seconds, so "po" → "por" → "port" is the single search "port". The same words
asked on several tabs within that window are one search, and a zero-result one
only if every tab found nothing. Control characters in a query print as `\xNN`. The same data
is `select * from public.search_query_report(7, 50)`.

Caveats: a search typed across UTC midnight counts twice; the first-page
requests of a person who never stops typing are still one per pause, so the
counts are searches, not people.
