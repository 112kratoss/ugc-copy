# Section 9O — managed provider-verification recovery

Baseline 93d7b0a3, candidate 9N. Five additional actual managed-job controls pass,
bringing the local HTTP/PostgREST suite to 19 cases. No new runtime/schema change.

A failed history lookup records a failed job without provider requests; a later
retry records success. With both local HEAD requests held, a second managed run
records already_running and sends no extra requests. An abandoned one-second
SQL lease blocks work until real expiry, then a new job completes.

Two controls launch a separate worker and send SIGKILL after a real provider
response or after the bulk snapshot insert commits. Before expiry, another job
is skipped. After expiry, it completes: the first boundary leaves zero checks,
then two after recovery; the second leaves two, then four after a fresh sample.
The killed job remains started. This records observable recovery and repeated
sampling, not exactly-once sampling or automatic repair of abandoned history.
Only the child's registry has a two-second lease; production remains 840 seconds.
SQL expiry and HTTP transport are real. The parent clock is fixed to the fixture
window; diagnostic logging is controlled. Only loopback HTTP is contacted.

The original local catalog is restored and all fixture catalog entries, snapshots
and job records are deleted; no fixture-owned lock remains. All 19 actual cases,
test typechecking and scoped lint pass. Private logs:
.audit-evidence/backend-social/model-verification-managed*.

Remaining scope includes a live old worker continuing after expiry, catalog
changes during the run, model-set paging/capacity/concurrency and real provider
behavior. JOB-01/JOB-02 are not whole-job certificates from these controls.
