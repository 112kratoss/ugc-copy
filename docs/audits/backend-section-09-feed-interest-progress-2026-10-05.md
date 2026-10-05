# Section 9L — make empty interest refreshes advance

Baseline e849da13. The refresh selects accounts by the oldest existing interest
row, with accounts lacking rows first. A legitimate refresh can produce no
interest rows: an audio-only creator maps to no normalized category, impression
weights can be zero, or positive/negative weights can cancel. Such an account
continues to sort first on every pass, starving later users once enough empty
results fill the batch.

The actual SQL regression uses an audio-only creator followed by an image
creator and a batch limit of one. Three baseline calls each report one processed
account, but the image creator never receives weights. Two permanent assertions
fail before implementation: reaching that user and refreshing it on a later pass.
No production data or provider was involved.

The migration adds private user_interest_refresh_state, one row per refreshed
account with cascade deletion. Candidate ordering uses the saved completion time,
falling back to existing weight timestamps for accounts not yet tracked. The
function saves completion even when there are zero dimensions, in the same
transaction as the weight rebuild. Wall-clock completion keeps progress when a
caller reuses p_as_of; weight calculations still use the supplied as-of time.
The existing invoker rights, advisory transaction lock, batch cap and interest
formula are preserved. Service access is SELECT/INSERT/UPDATE only; clients have
no table grants. No synthetic interest dimension is introduced.

Validation:

- Original real SQL regressions now pass; 19 SQL controls include role grants,
  RLS, argument bounds, atomic rollback when marker persistence fails and account
  deletion cleanup.
- A complete 1,000-user audio-only batch followed by a healthy account advances
  on the second call even with an identical as-of. A separate-connection advisory
  lock test confirms contending refreshes return zero without changing progress.
  These two actual SQL cases run in Quality's database job.
- Eight existing feed maintenance/route tests, a migration assertion, test
  typechecking and scoped lint pass. The initial expanded fixture had a missing
  UUID padding zero; correcting that fixture made the real 1,001-account case run.
- Clean replay followed by 2,087 SQL assertions/97 files passes, and public schema
  diff reports no changes. Eight proposed production rollback controls pass locally.

The new marker is account-bounded and removed on account deletion. It does not
place a wall-clock deadline on scanning/grouping active source users, certify
query performance at production volume, or isolate arbitrary SQL failures in one
user's rebuild. All existing source windows and aggregation math remain unchanged.
Historical production impact has not been measured, and no backfill is performed.

Migration 20261005170739 is local only. Exact-head CI, guarded merge, exact-main
standard release and independent planned-schema/role/rollback/cleanup/advisor
verification remain. JOB-02 is failed pending this release and retains broader
budget/retention obligations. Private evidence: .audit-evidence/backend-social/
feed-interest-* and feed-interest-release/.
