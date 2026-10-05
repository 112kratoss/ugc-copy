# Section 9E investigation — push send budget and overlapping workers

October 5, 2026; baseline `d87420ef` (9D candidate). Findings remain unfixed.
Only isolated local PostgREST/SQL and injected provider responses were used.

Three characterization probes reproduce the failure on the candidate:

1. Two direct maintenance invocations wait at a provider barrier, then both
   complete. Two retry requests occur but both store the old attempt count plus
   one. The row says two total attempts although the fixture's original attempt
   plus the two retries totals three. These calls bypass the registry lease;
   this proves the worker has no independent fence, not that ordinary scheduled
   calls routinely overlap. Lease expiry with a surviving old holder is the
   relevant remaining integration case.
2. Four successive maintenance invocations receive accepted provider tickets
   while delivery PATCH requests fail with injected 503 responses. Each job
   correctly throws after 9D, but each sends again. The row stays at one prior
   attempt: five requests in total exceed the configured maximum of three.
3. A separate Node sender is killed with SIGKILL after IPC confirms entry into
   the injected provider boundary. Before and after death there is no durable
   attempt advance; the replacement invocation sends and records only two total
   attempts. This proves lost accounting at process death. It does not claim the
   killed request reached a real provider or device.

The probes assert these observed baseline failures, so their three passing test
results are successful reproductions, not passing safety controls. Every fixture
user is removed; delivery and token absence are checked. Child exit is awaited;
no process is left running. No paid provider, push delivery, production row or
customer balance was touched.

Private reproducible evidence (not staged):
`.audit-evidence/backend-social/mobile-send-budget-{probe.test.ts,worker.cjs,baseline.log}`,
`mobile-send-budget.config.ts`, `worker.tsconfig.json` in the same directory.
The initial direct Node import could not resolve server-only; the private tsx
configuration maps it to the existing test mock. The child receives only the
local configuration path and minimal process environment, never .env.local.

## Required next fix and verification

Honor the existing three-attempt ceiling by durably claiming a delivery and
accounting for provider attempts before sending. A per-delivery ownership token
must fence both active claims and late finalization after recovery. Preserve
actual permanent-refusal information before retryable token cleanup, so reaching
the send cap does not strand cleanup work or require another provider request.
Distinguish unknown outcomes from confirmed refusals; the remaining budget must
not silently reset after a crash or failed ticket write.

Before shipping, convert the characterizations into failing safety regressions
and verify the fix at the actual database boundary: concurrent claims, failed
claim before sending, accepted ticket with failed persistence, killed sender,
late old-holder completion, known refusal with failed token cleanup, and normal
success/transient refusal recovery. If schema/RPC state is added, verify service
role admission and ordinary-role denial, replay the entire migration history,
and run the SQL suite. Keep genuine provider delivery separately open.

This document makes no new implementation or production-completion claim.
JOB-03 remains failed; the full audit goal remains active.
