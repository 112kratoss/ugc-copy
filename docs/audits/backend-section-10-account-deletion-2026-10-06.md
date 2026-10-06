# Section 10A — disposable account deletion and purchased-file recovery

Baseline 21641be2. Twelve actual local Auth/Storage/PostgREST/SQL controls pass,
with no runtime or schema change. The route adapter is called in process with
real signed-in GoTrue clients; only its cache callback and error logger are
controlled. Rate limits, identity lookup, job transitions, file copy, Auth
deletion, buyer entitlement lookup and signed file reads use the isolated stack.
This is not a deployed browser/proxy test or a real Apple revocation.

The cases cover:

- Owner Storage/Auth deletion, another account left intact, delayed resweep,
  repeated completion, and an actual signed-upload capability accepted before
  deletion but denied after the owner is blocked.
- Storage deletion failure leaving Auth and files intact, followed by persisted
  failure recovery; Auth deletion failure after Storage removal, then recovery.
- Anonymous denial, exact confirmation, recent-sign-in requirement, and a forged
  body target ignored in favor of the verified caller.
- Purchased revision retained in neutral Storage after creator deletion, with a
  real signed read returning the original PNG bytes to the buyer's entitlement.
- Retention-copy failure stopping before source/Auth deletion; mapping failure
  after a committed copy stopping deletion, then retry reusing the single
  deterministic copy and preserving the buyer's file.
- SIGKILL after the purchased file copy commits but before its mapping is saved,
  and SIGKILL after Auth deletion commits but before its acknowledgement returns.
  A new cleanup worker recovers both; the buyer still reads the original bytes.

Durable schedule timestamps are moved only for the confirmed-dead fixture or its
future resweep, so the tests finish without a two-hour wait. They do not establish
actual capability expiration timing. The first trial used an invalid two-second
cleanup lease; the SQL function correctly required at least 30 seconds, and the
fixture now uses 60. The first purchased-file fixture also used an unsupported
bucket-qualified attachment; the ownership guard rejected it before publication,
and the valid creator-prefix file fixture is used. Neither was a runtime defect.
Docker was stopped between sessions and restarted before the latest run.

The synthetic local paid order only seeds entitlement; no payment provider,
customer balance or Apple endpoint is contacted. Final-run cleanup removes the owner/buyer accounts,
Storage objects, retained copies, post/bundle/revision/order/purchase rows,
deletion jobs, permanent upload blocks/tombstones and rate keys.
The first two October 5 trials left six local blocked-owner fixture rows, later
identified by their exact timestamps and missing Auth identities and removed;
subsequent cleanup removes and checks these rows explicitly. Private logs and
that cleanup record are in .audit-evidence/backend-social/account-deletion-*.

All 12 actual controls, test typechecking and scoped lint pass. Remaining AUTH-03
scope includes linked guest identities, other resource/storage namespaces,
welcome-claim fingerprints, provider revocation, expired live worker races and
additional purchased revision/reference variants. Existing scoped SQL/unit
coverage is partial evidence; AUTH-03 stays untested until the full obligation
is proven. No production deletion was performed.

After incorporating main #372, the actual local suites pass again: 19 provider
verification and 12 deletion controls, with test typechecking passing. The merge
retains the added managed-worker controls; no runtime/schema change is included.
