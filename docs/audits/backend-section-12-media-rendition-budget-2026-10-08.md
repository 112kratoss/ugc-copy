# Section 12G — unused rendition repair reservations

Status: reproduced through actual local service, PostgREST, Storage and SQL.
Candidate passes six actual controls and 43 focused regressions. CI and standard
release verification remain pending. No schema migration is needed.

The rendition worker reserves a retry for every row it claims. When its time
budget ends, it breaks the processing loop but previously left unstarted rows in
`processing` with their attempts consumed. Repeating this can exhaust a row's
retry allowance without ever downloading it.

A two-row local fixture uses the worker's explicit zero-time budget, which still
permits the first row to run. Its missing source produces a real Storage error.
The worker reports one attempted download; SQL shows the untouched second row
still processing with attempt count one and the original lease. The expected
pending/count-zero state fails before the fix. Initial fixture construction had
an inconsistent SQL parameter type; that setup error is retained separately and
is not the application reproduction.

On a normal budget exit, the worker now releases only the unstarted tail of its
leased batch, subtracting the unused reserved attempt and restoring pending
status. Each update requires the exact row, original worker, processing state and
reserved attempt count. A replacement owner, changed attempt count or terminal
result cannot be overwritten. Failed release writes propagate as errors. A killed
worker still consumes its claimed budget because it cannot execute this normal
exit path; the crash-cost bound is preserved. Legacy unleased selection does not
create reservations to release.

Six actual controls verify:

- Three consecutive budget exits do not spend the untouched row's attempts. It
  remains eligible and runs after the older failing row exhausts its allowance.
- A different lease owner, a changed attempt count, and a terminal result each
  survive the original worker's attempted release.
- A rejected release write is reported and retains the reservation. A committed
  release whose acknowledgement is lost is also reported, while SQL retains the
  successfully restored pending/count-zero state.

The tests allow network access only to isolated Supabase, use exact disposable
IDs and verify zero users/posts/media after cleanup. The source objects are
deliberately absent, so no encoder or provider is invoked. These checks verify
claim/budget/release behavior, not rendition quality or genuine worker death.
Forty-three existing preview/repair-capacity tests also pass.

JOB-02 remains failed until the prevention release is independently verified;
the full media recovery and job matrices remain open. Private evidence is under
`.audit-evidence/backend-social/media-rendition-budget-*`.
