# Section 3 — client-callable privileged functions

Status: one confirmed admission bypass fixed locally; release verification pending.
Scope: public function grants and the six client-callable SECURITY DEFINER
functions. This does not certify every privileged business operation or trigger.

## Inventory

The production catalog contains 306 public functions: 223 SECURITY DEFINER,
15 with authenticated EXECUTE, eight with anonymous EXECUTE and 247 with
service-role EXECUTE. Six privileged functions are authenticated-callable;
none are anonymously callable. The timestamped inventory records each signature,
search path, execution mode and effective grants, including inherited privileges.

| Privileged client function | Boundary checked |
| --- | --- |
| current_identity_admission | Current JWT subject, session validity, ban and lifecycle |
| current_identity_state | Current subject's lifecycle |
| current_identity_is_active | Live session, unbanned and active lifecycle |
| current_identity_is_registered | Authoritative auth.users guest flag; independent of activity |
| start_workflow_canvas_run | Subject binding, canvas ownership, identity admission and shared quota |
| initialize_workflow_canvas_run | Same checks, atomic steps/job creation and idempotent service replay |

The remaining nine client-executable functions are invokers: three ordinary
helpers/operations and six trigger functions. EXECUTE on a trigger function
is not a directly callable RPC. Their exhaustive behavioral/trigger review
remains open; the inventory must not be read as certification of those paths.

## Confirmed issue and fix

The API enforced 20 starts per user per ten-minute window. The compatibility
legacy starter had a separate bucket, while the authenticated atomic initializer
had no internal quota and could create durable worker tickets directly.

A real Postgres regression first failed **6 of 38 assertions**. A separate
production transaction confirmed **21 initializer calls created 21 runs and
21 worker tickets**. All production writes rolled back before becoming visible
to workers. Trigger inspection found only local canvas-summary/timestamp
updates on the affected workflow tables. Independent checks confirmed zero
fixture users, runs and jobs afterward. No provider work was launched.

Migration `20260927161045_bound_authenticated_workflow_initializer.sql` makes
both compatibility starters use the API's `workflow-run:start` bucket. The
initializer meters authenticated callers only: the supported API uses the
service role after its own admission check, avoiding double charging. Signatures,
grants, ownership checks, guest compatibility and atomic initialization stay
intact. Rejected calls leave no partial run, step, ticket or counter increment.
The deferred stage-3 removal of compatibility grants remains a separate rollout.

## Validation

- Expanded RPC matrix: **41 assertions passed**, including the exact privileged
  function allowlist, no anonymous definer access, no client CREATE in public,
  owner/foreign-subject checks, guest compatibility, bans, revocation, deletion
  lifecycle, shared quotas, service bypass and service idempotent replay.
- Clean local replay: **255 migrations**, followed by **79 files / 1,610 assertions**.
- Local concurrent test: 30 calls on independent database connections using
  12 workers admitted exactly 20, rejected 10, and left 20 runs/jobs/counter units.
  Fixtures were removed from the isolated Docker database.
- Production rollback verifier: `scripts/ops/verify-client-rpc-boundaries.sql`.
  Temporary assertion helpers run as SECURITY INVOKER; all jobs and fixture
  state are rolled back. It tests database claims/roles, not token signatures.
- Production HTTP verifier: `scripts/ops/verify-client-rpc-boundaries.mjs`.
  Uses real disposable registered/guest sessions, empty canvases, current-subject
  reads and rejected mutations. Successful job creation is confined to the
  rolled-back SQL probe. The script removes fixture identities, canvases,
  unexpected worker tickets and scoped rate counters.
- Node syntax, focused ESLint and whitespace checks passed. CI/release evidence
  will be recorded separately after the normal release workflow completes.

The log review returned zero matching Postgres ERROR entries over its default
24-hour window; this is a filtered log count, not proof that every backend
operation succeeded. Existing security advisories were reviewed before the fix.

## Next batches

Service-only financial RPCs and their HTTP/webhook callers need independent
checks for caller authorization, payment signatures, replay/idempotency,
refunds, ledger invariants, payout transitions and concurrency. Storage,
Realtime, remaining invoker operations and trigger invariants also remain open.

[Supabase function execution and security guidance](https://supabase.com/docs/guides/database/functions)
was checked alongside the current changelog. Function EXECUTE grants and
SECURITY DEFINER behavior were verified against the actual production catalog.
