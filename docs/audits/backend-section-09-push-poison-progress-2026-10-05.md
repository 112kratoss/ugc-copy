# Section 9G investigation — push maintenance starvation

Baseline: initial-send candidate `fd3aa2a2` (PR #361), incorporating main
`177d6c98`. Three actual local PostgREST/SQL reproductions establish that one
record failure aborts the whole push maintenance pass before unrelated work.
Each case runs the actual service three times with the same oldest failed row
and verifies the healthy next row remains unchanged after every pass.

1. A saved initial outcome at the attempt cap fails its finalize RPC. The next
   saved accepted outcome remains unfinalized; receipt scanning, retries and
   retention never run.
2. A stale receipt fails its per-row update. A healthy due receipt remains
   pending without even a provider lookup; retries and retention never run.
3. An oldest retry fails its claim RPC. The next eligible delivery stays at its
   original attempt count without a claim; retention never runs.

The injected fault targets exactly the selected record through the real
Supabase client's HTTP transport; all other requests reach the isolated local
API and SQL confirms durable state. This demonstrates application failure
isolation, not an actual production outage or a particular database fault cause.
No provider call occurred in any case. Fixtures cascade-delete after each case
and SQL confirms no delivery remains for the fixture owner.

Evidence: `.audit-evidence/backend-social/mobile-push-poison-probe.test.ts`,
`mobile-push-poison.config.ts`, `mobile-push-poison-baseline.log`. The three passing
characterizations assert the defective behavior; they are not safety tests.
No runtime fix is included in this investigation.

JOB-02 returns to failed. Fix design must preserve durable attempt accounting,
claim fencing and token-retirement recovery while allowing independent records
and phases to progress and reporting partial failures observably. Catching errors
within the first batch alone is insufficient: a whole batch of persistently
failing oldest rows can still starve later rows. Verify bounded progress across
that boundary, recoverability of failed work, global outage behavior, retry
budgets, and unchanged successful delivery/receipt semantics before release.
