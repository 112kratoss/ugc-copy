# Section 12I — bounded upload reclaim progress

Status: reproduced and fixed locally; production release remains pending.

The service always selected the oldest 500 uncleared intents. A full batch of
still-protected uploads therefore prevented any later reclaimable object from
being reached. The actual local fixture creates 501 Storage objects and consumed
intents, protects the oldest 500 through the existing protection-set option, and
runs two sweeps. Before the fix, both scanned the same 500, reclaimed nothing,
and left all 501 intents open. Exact cleanup verifies zero users, intents and
Storage objects. The first fixture attempt had an inconsistent SQL parameter
type; that setup failure is retained separately from the valid reproduction.

The candidate adds an operational `reclaim_checked_at` marker and generated
`reclaim_priority_at`, equal to the last scan or the original creation time for
unscanned work. An index covers uncleared priority/id ordering. Each selected
batch is marked before external work, so protected, malformed, failed or
interrupted work rotates behind older waiting work. A marker-write failure aborts
before deletion. Nothing changes original upload age, the installed-client
rollout gate, reference protection, or the rule that absence/removal must be
proven before clearing bookkeeping. The migration changes no grants or policies.

The 500-row regression also rejected the initial marker PATCH with `URI too
long`: UUID filters are part of the URL. Both marker writes and final clearing
now use batches of at most 100 IDs. The fixture proves a later object is reclaimed
on the second sweep while all 500 protected objects remain; withdrawing
protection then removes and clears the full 500 without a URI error. The final
sweep scans nothing and all fixture objects are absent.

Eleven actual local controls pass (the nine 12H cases plus this backlog case and
failed marker persistence). Failed bookkeeping injection now targets the clearing
PATCH specifically, ensuring the new preliminary marker does not accidentally
consume that fault. Thirty-six focused tests, app/test types and scoped lint
pass. A clean migration replay and 2,350 pgTAP assertions in 110 files pass.
CI and independent production verification remain required.

This proves the named bounded progress and recovery cases, not concurrent legacy
reference creation, global queue throughput, real worker death or installed-client
expiry behavior. JOB-02 stays failed until prevention is released; broader
MEDIA-08/09 obligations remain open. A bounded read-only production inventory found 242 intents, 160 uncleared and zero consumed, uncleared intents older than 48 hours. It does not show a current affected eligible backlog, so no historical repair is indicated. No production upload was touched. Private
before/after logs and exact cleanup are under
`.audit-evidence/backend-social/upload-reclaim-progress-*`.
