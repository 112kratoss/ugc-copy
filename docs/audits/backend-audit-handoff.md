# Backend audit — session handoff

Updated 2026-10-06 (Asia/Kolkata). Read this first when continuing the section-by-section Magicbooklet backend audit.

## Workspace and authorization

Primary repository: `/Users/athuls/UGC copy/ugc-app`.
Active audit checkout: `/Users/athuls/UGC copy/auth-section-one` (reuse it; preserve uncommitted evidence).
Current checkout: `codex/model-verification-recovery-audit-9o`, incorporating main `c0f33e438800de69b6e99736ac2904141d0a93e1` (#371); prior audit branches remain preserved. Preserve local evidence.
Read the parent and repository AGENTS.md. The user authorized section-by-section audit, reproduction, fixes, verification, and deployment of completed batches. Production rollback fixtures are authorized. Do not charge providers, alter real customer balances, or run production contention/load tests as incidental probes. No new permission is needed for the already-authorized audit/release workflow. Do not spawn subagents unless newly authorized by applicable instructions.

## Exact checkpoint

9O adds five actual managed model-verification controls: durable failed/retried
history reads, overlap, abandoned expiry and SIGKILL after provider response or
committed snapshot. All 19 actual cases, test types and scoped lint pass. Original
catalog restored; fixtures/job rows removed; no fixture locks. No new runtime or
schema change. See model-verification-recovery report. Preserve separately from
9N PR #372, head 93d7b0a3, exact-head Quality 37362149076 running.

9N implements per-model latest verification history after an actual sparse-history
regression: 101 observations for one model hide another model's seven-failure
history in the old shared window. New service-only invoker lookup retains it and
breaks equal timestamps by identity. Fourteen actual local HTTP/PostgREST cases,
15 new pgTAP controls, app/test types and lint pass. Clean replay and 2,102 SQL
assertions across 98 files pass; no public schema drift. Seven bounded rollback
controls pass locally; model-verification-release/ has the production baseline,
one-migration plan and verifier. PR #372 is running exact-head CI; see 9N report. Runtime
change is only the lookup; no provider contacted. Preserve local edits.

9M #371 passed exact-head Quality 37353739378 on 9cc05bcf and merged with
mobile-store idle October 5 19:09:32 UTC as c0f33e438800de69b6e99736ac2904141d0a93e1.
Exact-main Quality 37361374584 is running. Standard release and independent
verification remain. Seventeen actual feed-maintenance recovery controls pass;
no runtime/schema change. Production limits/cache/overlong-holder fencing remain.

9L #370 is verified live on 63a2d7fb449844ac656e7d476ccd59646e01025e. Quality
37353506342/release 37355044779 passed. Independent October 5 19:08 UTC exact
SHA/schema/eight rollback/zero-fixture/health checks pass. Existing 109 advisor
findings unchanged plus one expected service-only RLS INFO. Source migration
20261005170739 recorded as 20261005181948. See feed-interest-release report.

9J/K #369 is verified live on 1acdc6865887d0e863e4b0d9fd07c567cd14e549.
Exact-main Quality 37351084486/release 37352679153 passed; independent 18:05 UTC
live SHA, feed/admin/webhook, unchanged schema and 109 advisors passed. See
backend-section-09-dispatch-release-2026-10-05.md. No runtime/schema change.

9I #368 is independently verified on d4c293a9f14b2f828e8636d03103b0faf6e5b700.
Exact-main 37345781975 and release 37347329859 pass. At 17:47 UTC exact-live
SHA/feed/admin/webhook and unchanged schema/109 advisor findings pass. See
push-summary-release report. Legacy summary remains best effort with explicit
failure logging; durable delivery drives recovery. JOB-03 returns to untested.

9H #364 is verified on 8ff10cc6480d2cea341a2157db21ba5d25b86f5d. Quality
37343916362/release 37344929966 passed; independent 17:03 UTC exact SHA/schema/
ACL/eight rollback controls/cleanup/109 unchanged advisors/health pass. See
push-registration-release report. Independent mobile #363/#360/#366/#365 preserved.

9G #362 is verified on 36962d613c5a70d3dc125319e25a37f63633e75b. Quality
37317775601/release 37319362945 passed; independent six rollback controls,
planned schema, cleanup and health passed at 13:50 UTC. One expected private-table
INFO was added to the unchanged 108 prior findings. See push-progress-release.

Current ledger 24 passed / 25 untested / 2 failed / 2 external (53). JOB-02 failed
for provider-verification history loss (feed-interest progress is released); MEDIA-07 failed for legacy retirement. Full goal active.
Preserve unrelated receipt edits, Section 1 files and all private evidence.

9F #361 is verified live on 32a3f47336a6ad54ff0c41b667d9ba41be8d12c2.
Exact-main Quality 37290134172 and standard release 37291187466 passed.
Independent exact-live SHA/schema/grants/eight rollback controls/cleanup/advisors/
feed/admin/webhook verification passed at 09:44 UTC. See first-send-release report.

9G scan/failure-isolation candidate is implemented locally: independent persisted
(created_at,id) scan positions, fixed sweep endpoints and one wrap; service-only
invoker RPC and RLS state table. Per-record/phase failures permit later work, then
throw a typed partial-result error persisted in the managed job's failed summary.
Eight actual controls include original four before/after regressions, managed
summary, concurrent scans, phase outage and SIGKILL after committed scan. Prior
16 retry/9 initial/4 receipt cases pass; 99 focused tests, app/test types/lint,
clean replay and 2,046 SQL checks pass. Clean-replay public schema diff reports no changes. Draft migration 20261005092947 is local only. PR, exact-head CI,
mobile-store idle before merge, standard release and production gates remain.
See push-poison-progress report for precise limits. Preserve unrelated edits.
Current ledger 24 passed / 24 untested / 3 failed / 2 external (53). Full goal active.

9E #356 is merged as cd264d3945fd3c77a7b5ffb665f3384973c6ec79 at 04:36:54 UTC.
Exact-head Quality 37263340019, exact-main 37264292974 and standard release
37264834355 passed. Production independently verified on descendant 177d6c989e
(Quality 37285060694, release 37286445214): only planned schema additions,
6 rollback controls, zero fixtures, unchanged 108 security advisor findings,
exact-live SHA/feed/admin/webhook checks. See push-claims-release report. Preserve
independent mobile #357–359 changes when incorporating main. JOB-03 stays failed.

9F candidate now reserves all initial device delivery rows before provider calls,
saves batch outcomes, and finalizes them with atomic matching-token retirement.
A known outcome refunds unused reserved slots; an unknown result retains all
three and is not resent automatically. This can lose unsent delivery opportunities
on crash and preserves existing rejected-batch single-device fallback accounting.
Nine actual local PostgREST/SQL controls, including real SIGKILL at provider and
saved-outcome boundaries, 101-device batching, partial batch failure and dedupe,
pass. Seventy focused tests, app/test types, scoped lint, clean replay and 2,023
SQL checks pass. See first-send-persistence report for precise limits. Migration
20261005043056 is local only. Candidate PR/CI/release/production checks remain.
All 16 actual retry-regression cases also pass, including real lease expiry.
Clean-replay public schema comparison reports no drift. Notification summary
writes and full registration/preferences/device evidence remain open.

9A–9D are verified live on 9903c6dcdfe63c9fa66398d572864061650cb2d2. #354 passed
37258797988 on 469d3231 and merged October 5 03:27:13 UTC with mobile-store idle.
Exact-main Quality 37259501863 and release 37260329433 passed; independent exact
SHA/feed/admin/webhook checks pass. See jobs-release report. JOB-02 returns to
untested; JOB-03 stays failed pending claim release and further evidence. Ledger
24 passed / 25 untested / 2 failed / 2 external (53). Full goal remains active.

9D #354 now incorporates main 19731ba9 after #353 merged. Only historical audit
notes conflicted; newest evidence retained, independent Android #351 changes
preserved. Fresh exact-head CI is required after this merge; do not use the prior
d87420ef run/attempt. Main 9C Quality 37258717262 is running. Finish 9D CI,
mobile-store idle check, merge, exact-main Quality and standard/live verification.
The new send-budget investigation report is included as open evidence only.
Local branch codex/push-send-budget-audit-9e at f6f96cb7 preserves the investigation
checkpoint; current 9D contains the same report plus this newer handoff.

9C #353 passed all four fresh-head Quality jobs in 37257838592 and merged as
19731ba9707f4d02b2e862575b7d1fb2d9a0e596 at October 5 03:15:31 UTC.
Mobile-store release was checked idle immediately before merge. Exact-main
Quality and standard production release/live verification remain. 9D #354 is
still d87420ef; retry attempt 2 of 37258103664 passed dependency installation and
is running web checks. Its DB/mobile/E2E jobs already passed. Finish it against
that exact head; inspect mergeability after #353, check mobile-store idle before
merge, and verify the released descendant includes 9A/9B/9C/9D.

9E is a local evidence/design checkpoint only, based on the 9D candidate; no
send-budget fix or schema change has been implemented. Its three new probes
reproduce the unbounded/undercounted sends. Do not call these passing controls.

9D is PR #354, head d87420ef. Six actual PostgREST and 77 focused tests, app/test
types and lint pass. CI 37258103664 hit an external HTTP 500 downloading the
ffmpeg-static README in npm install (before tests); retry only the failed web job
after the other jobs finish. Attempt 2 is now running web tests after a successful
dependency install; DB/mobile/E2E already passed. The early rerun attempt was
refused while the run was active. Private installation log preserves the upstream error.

9E investigation now reproduces three unfixed send-budget failures with actual
PostgREST: overlapping direct workers undercount, repeated accepted-ticket write
failures exceed three sends, and SIGKILL at the provider boundary loses accounting.
See push-send-budget report; private probes assert the bad baseline, not safety.
No candidate fix or migration exists yet. Next work is durable accounting/fencing
and token-cleanup recovery, with real concurrency/death regressions.

Main advanced independently to 22e2ed93 (#351 Android spinner). That cancelled
9B main Quality 37257678307 after DB/mobile/E2E passed and during web; verify
9B/9A on a fully checked/released descendant. 9C head e1b1abc3 remains in
37257838592 (DB/mobile/E2E passed; web continuing). Preserve independent mobile
changes. Current audit ledger remains 24 passed/24 untested/3 failed/2 external.

9D local retry persistence fix: six actual PostgREST cases fail before/pass after;
77 focused tests pass. Writes now report errors, the catch covers only provider
calls, and invalid tokens retire before terminal delivery updates. See push-retries
report. Accepted-ticket persistence failure still reproduces a duplicate send and
undercounted attempt on the next run; JOB-03 stays failed. New batch has no schema
or mobile runtime change. All fixtures removed; no real push sent.

9C #353 updated to e1b1abc3 after resolving only historical audit-document
conflicts against main 79192454; fresh CI 37257838592 running. 9B exact-main CI
37257678307 running. 9A release 37257450848 stopped at stale-main guard after
successful staging: preserve as expected safeguard evidence, verify its changes
on the 9B descendant after the standard release. Do not bypass promotion guards.

9B #352 passed updated-head Quality 37256707025 and merged as
79192454beba6584314eff54b11ff747790f60cc at October 5 03:00:59 UTC with
mobile-store release idle immediately before merge. Exact-main Quality/release
remain. 9C #353 passed 37256762027 on 54c69068; merging new main requires fresh
head checks. 9A exact-main 37256639143 passed; release 37257450848 was still
staging when main advanced, so inspect its stale-release result and subsequent
retention release before claiming production completion.

Current 9C candidate is PR #353, now incorporating 9B head da2dc256 and main
80a3d303. Main #349 Quality 37256639143 running. 9B/9C must use their new-head CI
before merge. Their earlier checks apply only to their prior heads. The twelve-job
matrix now records each entrypoint, existing evidence and missing cases; it is not
certification. Preserve the unrelated mobile changes from main and receipt/Section 1
local evidence. Full goal remains active; ledger 24/24/3/2.

9A #349 passed exact-head CI 37255743353 and merged as
80a3d303fbf0c31e68a26c152c0c90f93734e485 at October 5 02:45:21 UTC.
Mobile-store release was idle immediately before merge. Exact-main CI and standard
release remain to verify. 9B #352 initially passed CI 37255805722; its branch now
incorporates this main, preserving independent Android preview change #350.
Only historical audit docs conflicted; latest evidence retained. New head CI needed.

9C receipt maintenance: four actual PostgREST fixture cases fail before and pass
after checking writes and retiring invalid tokens before receipt finalization.
A failed retirement previously left the token active and receipt terminal. Partial
write retries now retain pending work and preserve first disabled_at. No migration
or provider request. 73 focused unit cases, app/test types/lint pass. New tests/
report/source are local, PR/release next after #352. See push-receipts report.
Ledger: 24 passed, 24 untested, three failed, two external; JOB-03 reopened.

9B #352 Quality 37255805722 running; #349 Quality 37255743353 running. Both have
DB/mobile/E2E passed and web still progressing. Full audit remains incomplete.

9B is PR #352, branch codex/retention-observability-audit-9b, pushed after merging
updated #349 branch (04e836d8). CI pending. #349 now incorporates main #348 plus
the unrelated mobile preview changes; inspected conflicts were only old audit
checkpoints and resolved to the latest evidence. New #349 CI is 37255743353.
Do not use the previous head's green checks to merge this updated candidate.

8H #348 release verified: exact-main Quality 37235572061, standard release
37236449862 success October 4 21:35:08 UTC, independent exact SHA/feed/admin/
webhook checks pass. See share-controls-release report. No runtime/migration change.

9B reproduces silent supplementary retention errors / rejected calls stopping
later work (eleven failing baseline service cases). Fix saves failed operation
names in durable job summaries and logs each failure while continuing best-effort
prunes; object reclamation still stops bookkeeping on error. 39 focused tests and
one actual managed-job PostgREST persistence/retry test pass; app/test types/lint
pass. No migration/mobile runtime change. See retention-failures report.
Ledger: 24 passed, 25 untested, two failed, two external; JOB-02 reopened for 9B.
Candidate needs PR/CI/release after #349. Current branch includes #349 pending base.

8H #348 passed all four PR jobs and merged 360d62496aa3dc91ffc97cb7ed0139a024a8f726
at October 4 21:18:35 UTC, with mobile-store idle immediately before merge.
Exact-main CI/standard release remain to verify. #349 PR CI 37235238993 has three
jobs passed and web still running. Inspect/update its base against merged main.

9A PR #349 is open (head 24e436b3), including the pending #348 base until that
merges. Its tests/docs are pushed; no runtime/migration change. #348 Quality
37234612545 has DB/mobile/E2E success and web progressing after its tests passed.
Finish #348, then merge main into #349 and resolve only inspected docs conflicts,
update its final PR description, finish CI and normal release. Check mobile-store
idle immediately before every main merge. Preserve unrelated receipt/Section 1 edits.

Isolated API stack was restarted without resetting its volumes, with Realtime
now healthy. local-status.json was refreshed privately. No Next server remains.
Final local 9A run passes seven tests; typecheck and warning-free scoped lint pass.
Both Realtime attempts cleaned fixtures and disconnected all channels.

8G is fully released as 44864e56. Exact-main Quality 37234106785 and standard
release 37234741646 pass (October 4 21:10:17 UTC). Independent exact live build,
feed/admin/webhook checks pass. See social-inputs-release report. SOCIAL-02/04
return to untested for remaining behavior.

DB-04 current configuration is verified: production/local empty publication,
no application channel producer/consumer, three actual local socket identities
across changes/deletion receive no row events. Report records transport failure
before enabling isolated Realtime and the precise limits. Reopen before enabling
streams/channels. Ledger: 24 passed, 26 untested, one failed, two external (53).
9A job-lock tests and these release/Realtime docs are in the current local branch for the next PR.
8H #348 Quality 37234612545 is running. Full goal remains incomplete.

DB-04 investigation: production and isolated local publication inventories both
show supabase_realtime with all_tables=false and zero tables; current web/mobile
source has no Postgres Realtime channel consumer. First actual socket probe hit
transport failure because audit Realtime container was excluded, not an access
control result. It cleaned up all fixtures. Isolated audit stack is being restarted
with Realtime enabled (primary stack untouched); retry socket checks next.
Private evidence: .audit-evidence/backend-realtime/.

8H tests/docs PR #348 is open, head 0f3442b8, Quality 37234612545 running.
8G exact-main Quality 37234106785 passed; standard release 37234741646 running.
Finish that release and independent live checks before closing its scoped failures.

9A local shared job-lock tests: seven actual PostgREST/SQL cases pass, including
SIGKILL of a real holder and replacement only after real lease expiry. Types/lint
pass. New tests/config/report are uncommitted for the next audit batch. This is
shared-primitive coverage, not certification of all twelve jobs.

8H share controls: thirteen actual PostgREST/SQL tests and ten assertions across
six real Next HTTP requests pass; no new runtime defect. Caller attribution,
visibility, both block directions, concurrent counters and deletion behavior are
covered within the share-boundaries report's limits. Types/lint pass. Tests/docs
only; no migration. The local server is stopped and fixtures removed.

8F is released and independently verified on exact SHA 94d1bf0c. Main Quality
37230606348 and standard release 37231227200 pass (release 20:17:02 UTC October 4).
Five production rollback controls pass, cleanup is zero, function bodies match,
and the canonical schema query proves only the one service grant changed.
108 individual security advisor findings unchanged. See the 8F release report.
The initial expected-grant digest calculation failed; canonical query excluding
exactly the added grant reconstructs all baseline digests and resolves the check.

8G #346 passed all four PR CI jobs, merged 44864e5667eb6a9ed7d81bcc6faa5138590a8767
at October 4 20:57:31 UTC with mobile-store idle immediately before merge.
Exact-main Quality 37234106785 is running; standard release/live checks next.
Current ledger: 23 passed, 25 untested, three failed, two external. Full scope open.

Earlier checkpoints follow; current status above supersedes their running states.

Invoker helper follow-up: 327 functions/118 triggers reviewed for explicit
public-qualified calls under invoker rights. Only remaining candidate is an
immutable revision helper; service direct UPDATE is denied, and actual service
bundle deletion preserves the detached revision. No new defect. Read the
invoker-helper-review report; broader SQL call-chain coverage remains open.

8G grouped malformed-input audit: 28 actual local Next requests across fourteen
social routes reproduced thirteen 500 responses on seven endpoints. Five JSON
adapters plus post-report/form parsing now return their client errors. All 28
HTTP controls pass afterward; 69 focused web/130 mobile contract cases and types/
lint pass. Permanent regressions failed 13/14 before. Read social-inputs report.
No migration/mobile runtime change. PR #346 head cbd0df38, Quality 37231029795
is running. Finish checks, mobile-store idle check before merge, exact-main
Quality and standard release. Dev server is
stopped and fixtures removed. Ledger: 23 passed, 24 untested, four failed, two
external (SOCIAL-01/02/04 and MEDIA-07 failed). Full scope remains open.


8E is released and independently verified on descendant 644a0e3d, which retains
both adapters unchanged. Its own release 37229182326 and main CI 37228400582
passed; live descendant release 37230192044 and CI 37229440421 passed. Read the
profile/contact release report. SOCIAL-04 returns to untested.

8F #345 passed all PR CI 37228631674 and merged as
94d1bf0c3b3304790125d43bafca78216557534c at October 4 20:03:03 UTC.
No mobile store release was active immediately before merge. Main Quality
37230606348 is running; standard release and restore-release/verify.cjs next.
That verifier checks the intended grant delta, five rollback controls, cleanup,
function digests and advisors. Ledger: 23 passed, 26 untested, two failed,
two external. Full audit remains open.


October 5 continuation: 8E #341 passed all four PR CI jobs 37215420224 and
merged as 61620d00f5461f6fa86e19a7336b690bd20fe480 at October 4 19:28:26 UTC.
No mobile-store release was active immediately before merge. Exact-main Quality
37228400582 is running; standard release/live verification follow. Local branch
includes main and the independent mobile UI fixes #340/#342/#343.

8F reproduces service-role recipe restoration failing 42501 and a delayed archive
response demoting a newly restored recipe. New migration 20261004161150 grants
only the trusted service the existing private quality helper. It is applied to
local 55322 (not its migration ledger) and clean replay 55332. All 1,970
pgTAP assertions across 92 files pass after replay, including the new ten.
After removing the redundant service demotion, all four PostgREST cases pass.
The new pgTAP role test failed 5/10 before. Fifteen focused tests, types/lint pass.
8F is PR #345, head 1880023e; Quality 37228631674 is running. Fresh production
ledger planning finds only 8F pending and no ordering conflict. Five bounded
production rollback controls reproduce the missing grant (three pass/two fail);
separate cleanup readback is zero. Local after-fix rehearsal passes five/five.
Production advisors/fingerprints are saved before release. Supabase MCP tools
disappeared, but existing CLI login works: private restore-release/management.cjs
uses only its documented Keychain entry, keeps credentials in memory and verifies
the project identity before queries. No new plugin connection is needed.
Next finish PR checks, then mobile-store idle check immediately before merge,
exact-main Quality, standard release and independent production checks.
Read backend-section-08-post-restore-2026-10-05.md. Full scope remains active.


8C #338 is fully released as 7116126d. Exact-main Quality 37207818947 and
standard release 37208546610 pass (release 14:18:52 UTC). Independent exact live
SHA/feed/admin/webhook pass. Both function digests match clean replay; ledger
version 20261004141520. Four production rollback checks pass, separate fixture
cleanup and follows-across-blocks readbacks are zero. Security groups unchanged;
only function schema fingerprints changed. Read the follow/block release report.

8D #339 passed all four PR Quality jobs (37208266763), then merged as
6808cd7c4fd1345c8f436bc1a3c15e33f3fbfae7 at 15:53:46 UTC October 4.
No mobile store release was active immediately before merge. Exact-main Quality
37214724770 passes all four jobs. Standard release 37215325204 succeeded at
16:07:17 UTC; independent exact live SHA/feed/admin/webhook checks pass.
No migration in 8D. Read the comment-lifecycle release report.

8E reproduces malformed/null JSON returning 500 on PATCH /api/profile and
POST /api/profile/validate through actual local Next HTTP (four failures/eight
controls pass). Both adapters now return 400 for malformed/non-object payloads.
After-fix HTTP 12/12, PostgREST profile/contact 7/7, focused web 67/67 and mobile
contract 123/123 pass, with types/lint. Permanent adapter baseline: ten failed,
ten passed; real HTTP confirms malformed/null failures (other primitive cases
are unit boundary coverage). No migration or mobile runtime change. See the
profile/contact report. PR #341, head 1216eb0c, Quality 37215420224 running.
Next finish PR checks, check mobile-store-release immediately before merge, then
exact-main Quality and standard release. Full audit remains open.

Thirteen actual creator-page HTTP controls pass: public-only post projection,
private fields omitted, owner/follow state, pagination, caching, both block
directions and missing creator. Initial fixture table-name error was corrected;
both runs cleaned up. See creator-visibility report. No runtime change from this
matrix. Local dev server is stopped. Keep this evidence for the next audit PR.

New read-only follow-up closes JOB-04: the original report (created September 27
12:35:19.186226 UTC) is dismissed, reviewed October 1 05:09:36.862171 UTC with a
reviewer. Both queues now empty, latest watchdog 37203705619 passes. No audit
mutation. See moderation-queue follow-up report. The explicit HTTP method map
records 162 routes/186 methods but does not close MAP-02. New evidence/docs are
local for the next documentation batch; do not restart PR CI just to record them.
Ledger: 23 passed, 25 untested, three failed, two external. SOCIAL-01/04 are failed
until 8E is released; broader profile/creator coverage remains open.

8B #337 is released as e5bc769b. Exact-main Quality 37201725874 and release
37202416554 pass (release 12:35:38 UTC). Independent live SHA/feed/admin/webhook
pass. All three function digests match clean replay; ledger version 20261004123218.
Production rollback controls pass 4/4, cleanup zero. Nine historical count
mismatches were rehearsed, then repaired with bounded NOWAIT locks. Independent
38-post readback has zero mismatches. Security advisor groups are unchanged.
Read the save-counter release report and preserve private save-release evidence.

8C #338 passed PR Quality 37201786228 and merged 7116126d at 14:02:51 UTC
October 4, with no active mobile store release immediately before merge.
Exact-main Quality 37207818947 is running; standard release/live/digest checks next.
8D reproduces comment-list exposure across a post-creator block in either
direction (two fail/six pass actual PostgREST baseline). The fix checks the creator
in the existing block set, with an exact lookup on truncation. Eight transport and
46 focused cases pass; eleven actual SQL lifecycle cases are now wired into CI.
Read `backend-section-08-comment-lifecycle-2026-10-04.md`. Candidate PR/CI/release next.
SOCIAL-02 returns to untested after 8B; SOCIAL-03 remains failed for 8C/8D.
Ledger: 22 passed, 26 untested, two failed, three external. Full scope and external
gates remain open.

The preceding checkpoint follows.


8B PR #337 (head 91e38f05) passed all four Quality jobs in 37201195516 and
merged as e5bc769b at 17:49:48 IST October 4. No mobile store run was active
immediately before merge. Exact-main Quality 37201725874 is running; standard
release and live verification follow. Migration plan has only 8B pending against
the captured production ledger. Existing drift repair SQL is
private, rollback-by-default, NOWAIT table locks, capped at 20 mismatches;
four isolated rehearsal controls pass. Apply only after prevention release is
verified, preserving before/after evidence and independent zero-drift readback.

8C now reproduces block/follow races in both orders/directions: four failed,
two passed before. Both triggers now share a sorted-user-pair transaction lock;
six SQL cases pass. Actual PostgREST also reproduced a false 500 for a block
committing after the precheck; the exact guard error maps to 404. Four actual
HTTP/service transport cases and 43 focused cases pass, types/lint pass.
Clean replay passes 1,960 pgTAP and 18 combined actual save/block cases.
Migration 20261004121413 is local; candidate CI/PR/release next after 8B merge.
Read `backend-section-08-follow-block-race-2026-10-04.md`. Production read-only
inventory has zero follows across blocks; no relationship repair is needed.
SOCIAL-03 becomes failed; ledger: 22 passed, 25 untested, three failed, three
external. Current live verified remains 8A e6d8e81d. Preserve unrelated changes.

The preceding checkpoint follows.


8A #336 is deployed and verified as e6d8e81d. PR Quality 37199243395,
exact-main Quality 37199914979 and standard release 37200570697 passed.
Merge 17:17:23 IST October 4; release 17:33:46 IST; live checks 17:35:16 IST.
No active mobile store run preceded merge. Read the follow retry release report.

8B reproduces save-counter drift after account deletion and concurrent legacy
toggles. Permanent baseline: six failed/two passed. Candidate migration
20261004114652 preserves service-only RPC grants, serializes save intents per
pair, counts only actual legacy deletions, and decrements actual deleted saves
before Auth deletion. Clean replay + 1,960 pgTAP assertions and 12 SQL cases pass;
actual local Auth API deletion passes. Read `backend-section-08-save-counters-2026-10-04.md`.
Candidate CI/release next. Production rollback baseline passes 2/4, cleanup zero.
Production aggregate: 38 posts, nine save-count mismatches (+9); no historical
repair performed, cause not attributed. SOCIAL-02 remains failed for this work.
The ledger stays 22 passed, 26 untested, two failed, three external.

A separate private replay stack at DB55332 (project magicbooklet-social-replay)
has migrations/tests symlinked from the checkout. Original 55321/55322 stack is
preserved. Docker stopped and was restarted; candidate subsequently applied only
locally. New private evidence is `.audit-evidence/backend-social/`; production
probe variable and initial Auth fixture errors were corrected and retained.
The private comment probe passes eight boundary controls. Keep the full audit
scope open; the historical source-map and other domain obligations remain.

The preceding checkpoint follows.


7K #333 is released. PR Quality 37195063530, exact-main Quality 37195747753 and
standard release 37196169222 passed. Merge b8f9c312 at 16:03:30 IST October 4;
release completed 16:14:35 IST. No active mobile store run preceded the merge.
Independent live checks verify descendant 4e4186a5 (release 37198669693) at
17:01:42 IST: exact SHA/feed 200/admin 307/unsigned webhook 401. Read
`backend-section-07-template-inputs-release-2026-10-04.md`.

8A reproduces a false 500 when two follow requests read no row then insert the
same pair through actual local PostgREST. A confirmed 23505 duplicate now returns
success without a second notification task. Three permanent SQL/PostgREST cases
and 35 focused service/route tests pass; app/test types and lint pass. Read
`backend-section-08-follow-retries-2026-10-04.md`. Candidate CI/release next.
WORKFLOW-04 returns to untested after 7K; SOCIAL-02 is failed until 8A is released.
Ledger remains 22 passed, 26 untested, two failed, three external.
Notification tasks are captured, never executed. Private logs/config remain in
`.audit-evidence/backend-social/` and `.audit-evidence/backend-storage/`.
Continue the social behavior matrix while CI runs. No full-audit completion claim.

The preceding checkpoint follows.


7J #331 passed PR Quality 37191142092 and merged as 49b89e7a at 14:50:02 IST
October 4, with no active mobile store run immediately before merge. Exact-main
Quality 37191811350 and standard release 37192468056 passed (release 15:05:16 IST).
Main advanced through #330/#326 to 28b7467c, now incorporated. That descendant's
release 37194103115 and independent exact-SHA/feed/admin/webhook checks pass.
Read the assistant-apply release report. Existing unrelated edits are preserved.

7K reproduces a real local Storage/PostgREST race: two successful finalizations
from one saved input map leave two final objects, only one referenced. The fix
compares the complete saved input JSON atomically in the existing run UPDATE;
losers return 409 and clean their prepared copy, retaining staging for retry.
Seven real Storage/HTTP cases and five permanent service regressions pass,
including same/different-slot races, run-start conflict, malformed image/metadata,
consumed tokens, replacement and committed-but-lost acknowledgement. App/test
types, lint and diff checks pass; focused template suite passes 213 (53 skips).
The existing actual template-run DB suite also passes 25 cases (one harness skip).
Current runtime/tests/report are local, awaiting candidate CI and release. Read
`backend-section-07-template-inputs-2026-10-04.md`. Ledger is 22 passed,
26 untested, two failed, three external. WORKFLOW-04 is failed for unreleased 7K.

The audit's isolated database now has API/Auth/Storage on 55321 as well as DB55322.
The disappeared temporary config was reconstructed in private
`.audit-evidence/backend-storage/local/`; CLI2.75.0 restarted only the isolated
stack, preserving its DB (326 functions). Primary 5432x stack untouched. Local
status JSON/start logs contain local credentials: keep private. Seven HTTP cases
run via `vitest.template-storage.config.ts` with explicit AUDIT_STORAGE_CONFIG and
SUPABASE_TEST_DB_URL. Standard CI runs the service regressions, not this opt-in suite.
44 fixture users/runs/templates and objects were removed; 59 reservation rows remain
under retention. IDs/readback/logs are private. Do not call retention complete or
disable triggers to erase evidence. No paid/provider calls or production mutations.

Continue 7K verification/PR/release, then the broader workflow/Storage matrix.
MAP-02 reviewed reconciliation remains partial: 85 catalog, nine source/operator,
34 SQL call entries, 24 needing entrypoint/compatibility evidence. Provider/operator,
identity/recovery, commerce/social/jobs and operational obligations are still open.
Do not call the full audit complete from scoped tests or a green release.

The preceding checkpoint follows.


Current branch is `codex/assistant-discard-audit-7g`, incorporating main
9416008a. 7F combined-main PR Quality 37124830807 passed all four jobs. #294
merged at 18:44:56 IST with no mobile store release active. Exact-main Quality
37125525853 is running; standard release/live checks remain pending. Local combined
checks passed 14 database cases, 105 focused cases, app/test types and lint.
Independent live checks pass on descendant 7d6a6d11 containing the 7E fix.
Later production release 37124633899 for 6df13e5d passed.

7G reproduces three assistant discard failures with actual authenticated SQL:
already-applied overwrite, apply committing after the discard read, and a
rejected write reported as success. The fix conditionally updates only ready
owned proposals, reports errors/conflicts, and returns the written row. Seven
DB cases, nine focused tests, app/test types and lint pass. Read
`backend-section-07-assistant-discard-2026-10-03.md`. This is separate from 7F;
PR #308 now targets main, incorporating 9416008a. A route-test fixture needed
its update projection brought in line with the new persisted-row response; all
20 route/rate-limit cases then passed. Updated-main CI is next. Preserve both
release sequences. WORKFLOW-04 remains failed with the unreleased discard defects.
Ledger: 22 passed, 25 untested, three failed, three external.
Three private SQL controls additionally pass for stale assistant apply, history
insert rollback and competing proposals at the same revision. The next source
leads (not validated findings) are in private `next-authoring-boundaries.md`.

The preceding checkpoint follows.


Current branch: `codex/canvas-approval-audit-7f`, incorporating main 6df13e5d.
7E PR #293 deployed as f1ec34dc: exact-main Quality 37098042595 and standard
release 37098645999 passed; release completed 10:38:17 IST October 3.
7F PR #294 passed updated-main Quality 37098113173 on 02dccd2b, but main later
advanced through #295–307, including canvas busy/catalog and template termination
fixes. Those changes are now incorporated cleanly. The combined local actual SQL
suite passes 14 cases; focused/type/lint checks are being finalized before fresh
CI. Do not reuse the older green check to certify the newer combined tree.

The earlier #292 completion/worker-recovery release remains verified as f6a3d3b1:
exact-main 37095001982, release 37095645751, independent public checks. See
`backend-section-07-completion-recovery-release-2026-10-03.md`.

The 7F function commits checkpoint approval, run continuation and queue wake in
one transaction. Actual SQL reproduces the old half-approved strand; rollback,
concurrent approval, owner/role restrictions and lost acknowledgement pass.
Read `backend-section-07-atomic-approval-2026-10-03.md`. No historical rows were
rewritten. Read-only production aggregate SQL at 04:23:54 UTC found zero current
rows matching either narrow canvas-failure signature. Private query/readback are
saved. A later private callback-order probe passes processing/succeeded/failed
callbacks arriving before link-write recovery, with no duplicate charge.

No mobile store release is currently active; check again before every merge.
PR #294 targets main. Complete current-head CI, exact-main Quality and the normal
production release, then independent live checks. Broader WORKFLOW-02/03/04 are
still open. Ledger: 22 passed, 26 untested, two failed, three external; the unreleased
approval defect keeps WORKFLOW-02 failed. Existing local receipt/Section 1 edits
and private evidence are untouched.

The preceding checkpoint follows.

Section 6S is deployed as dd3d6c13. PR Quality 37052965820, exact-main Quality
37055063444 and standard release 37056337938 passed. Release completed October 3
01:20:18 IST. Independent exact SHA/feed/admin/webhook checks pass. Read
`backend-section-06-metadata-lifecycle-release-2026-10-03.md`. Legacy environment
retirement remains unverified, so MEDIA-07 is still open.

Section 7A PR #289 merged as 475fe2b7 on October 3 at 01:39:35 IST. Updated
PR Quality 37057488661 passed all four jobs: 6,650 web, 2,911 mobile, 21 browser,
1,941 SQL assertions, 142 DB cases (one harness skip), native checks and 163 traces.
First CI failure 37056295355 exposed the real concurrent-retry race and remains
recorded. The final transaction fix passes 17 actual DB cases in ten consecutive
runs. Exact-main Quality 37058779424 passed all four jobs. Standard production
release 37059587121 passed first attempt at 01:51:18 IST. Independent live checks
pass on descendant c7a8419b (#290, release 37062922373). Read
`backend-section-07-template-lifecycle-release-2026-10-03.md`. No mobile store release was active before merge.

Intervening main 38048f43 (#283 reference-card handle) is incorporated. Its release
37058745760 correctly rejected the stale SHA before changing production after
#289 merged. Current independently verified production is c7a8419b, containing 7A.

Section 7B PR #291 contains publication-acknowledgement cleanup fix, runtime commit
69cdc871, plus merged main. A committed immutable version lost its referenced
asset after activation reply loss; permanent service and actual service-role SQL
before/after probes reproduce/fix it. SQL commit was confirmed by a second
connection; Storage was controlled in memory. The disposable database was removed.
Read `backend-section-07-publication-acknowledgement-2026-10-03.md`. Five new cases
and existing focused suites pass, app/test types and lint pass; full candidate
suite passes 6,655 tests (141 skipped) before the #283 test addition. PR Quality
37059027223 passed all four jobs: 6,658 web, 2,911 mobile, 24 browser, 1,941 SQL,
142 DB cases (one harness skip), media probes and 163 traces. PR #291 merged as
34e8387f at 08:54:15 IST with no mobile store release active. Exact-main Quality
37093085015 is running; standard production release/live checks remain pending.

Section 7C extends the real-DB fixture through video completion and partial
failure/retry. Nineteen cases pass; test types and lint pass. Both media kinds now
call their actual start/hold/settlement services with controlled node settings.
No new runtime fix; these test changes are in the local 7C branch and not in PR #291.
Read `backend-section-07-downstream-completion-2026-10-03.md`. Provider
network/status sync and media transport remain mocked; process death and the real
node executor remain unverified. PR #292 contains the lifecycle tests (1037ce43) and method map (13df4ac7).
The next update also includes Section 7D actual worker death after job claim and
provider attachment. All 21 DB cases pass, one child-harness skip; types/lint and
empty DB readback pass. Two real SIGKILL/restart cases preserve live leases and
recover after controlled expiry without duplicate holds or provider submissions.
Read `backend-section-07-worker-recovery-2026-10-03.md`. Updated PR CI is next.
`backend-section-07-method-matrix-2026-10-03.md` inventories all 36 exported methods
across 31 workflow routes, with explicit remaining evidence. This is not closure.

No whole workflow obligation is closed by these scoped cases. Ledger remains
22 passed, 27 untested, one failed, three external.

The preceding checkpoint follows.

Section 6R is deployed: PR #281 merged as 20862a0b. Updated PR Quality
37037902850, exact-main Quality 37039015096 and standard production release
37040248048 passed. Release completed October 2 at 17:25:53 UTC / 22:55:53 IST.
Read `backend-section-06-capacity-admission-release-2026-10-03.md`. MEDIA-06 now
passes its cooperating-writer scope; ledger 22 passed, 27 untested, one failed,
three external. No global filesystem or production throughput claim is implied.

Current 6S metadata lifecycle fix is uncommitted and under final validation.
Private `.audit-evidence/backend-section-06s/` records the real 31-kill/64-inode
failure, 400 candidate kill controls, five failing permanent regressions, inherited
reader/live allocator/unknown metadata controls, and an old/new admission
compatibility failure caught before shipment. The fix uses item2- only during
initialization under the root lock, then atomically renames to the old item-
prefix before releasing admission. Older capacity-aware workers therefore count
new claims too. Name collisions preserve existing workspaces. Legacy unpublished
item- metadata and unknown payloads remain untouched. Final local targeted
workspace run: 38 passed; updated-main focused suite: 83 passed; all ten isolated
worker cases pass (one harness skip). Native FFmpeg/admission regressions pass.
Read `backend-section-06-metadata-lifecycle-2026-10-03.md`.
One full-suite attempt under heavy shared-host load timed out; its log is kept.
Later runs were interrupted by the session boundary and are not passes. Cleaned
one verified abandoned audit-crash fixture on isolated port 55322; no customer
or other checkout rows were touched. All type projects and targeted lint pass
on updated main. The completed two-worker full suite passes 6,648 tests
(129 skipped). Final 6S CI/release remain pending.

Main advanced through #282 and #284 to 24194f1d; both incorporated by fast-forward
without changing local edits. Live 1361e2c4 independently passed SHA/feed/admin/
webhook checks. Later release 37051401271 for 24194f1d failed protected live build-ID
verification after promotion; do not call that run successful. Subsequent
independent public SHA/feed/admin/webhook checks pass on 24194f1d; protected
health on that latest build is not independently reverified. Preserve unrelated receipt edits,
Section 1 files and private evidence. Next: finish/CI/release 6S, then the prepared
WORKFLOW-02/03/04 matrix in private `backend-section-07/coverage-prep.md`.

The preceding checkpoint follows.

Section 6R shared staging admission is implemented and locally verified, not yet
released. Read `docs/audits/backend-section-06-bounded-writer-contention-2026-10-02.md`.
All seven writer allocations now declare enforced ceilings. Root-directory flock
serializes admission; immutable lease claims survive inherited children, source
completion releases only growth, and block/inode headroom rejects excess work
before allocation. In-flight partial bytes are deliberately over-reserved to avoid
truncate/rewrite races; completed-source bytes are counted only through actual
filesystem occupancy. Unknown active legacy claims/unsupported filesystems fail
closed. Coordination covers cooperating writers on the common root only.

The real two-writer regression fails before (2 admitted vs 1), passes after,
and verifies completed/partial source markers and parent-death claim retention.
Original 10.5 MiB real-FFmpeg ENOSPC probe now yields one success/one early capacity
denial, intact source, no encoder ENOSPC and empty cleanup. A 64-inode probe admits
five writers and leaves 37 inodes after all writes/seals. Existing real media
normal/failure/abort/orphan regressions pass. Ten actual isolated-DB worker cases
pass, including capacity denial -> retry -> one upload/notification with stable
380/80 credit balances. Separate DB readback is empty. Final focused 73 cases,
all type projects, lint (two existing warnings), and updated-main web suite
6,583 passed/127 skipped pass. Final repair-focused suite: 70 passed.
Capacity refusal now restores preview/rendition/teaser/playback retry allowance
with lease/source/count guards where claims omit their ordinal. Reproduced and
fixed the skipped final leased attempt (ordinal 3); ordinal 4 remains rejected.
Real isolated worker rerun: ten passed, one harness skip. Final Linux admission
run passes. PR #281 runtime commit 12687d78 is open. First Quality
37037025984 exposed shared-queue test interference; reproduced locally (two
failures) and fixed by sequential recovery test files, preserving explicit
in-test concurrency. All 68 DB cases then pass (one harness skip). Updated
CI and release remain pending. Private 6S metadata-kill reproduction and
candidate cleanup proof are saved; no 6S runtime edits are included in this PR.

Main advanced through seven PRs to 1f31715c. They are incorporated without conflict,
including new workflow/template/notification fixes and mobile audio. Read the new
AGENTS notification contract guidance. Current production 1f31715c release
37022122147 succeeded and independent SHA/feed/admin/webhook boundary checks pass.
Local 6Q release documents and 6R evidence are preserved for this PR; unrelated
receipt and Section 1 files remain excluded. MEDIA-06/07 stay failed/open until
closure evidence is complete. Next: CI/release this batch, then legacy metadata
policy and WORKFLOW-02/03/04, reusing the newer workflow regression evidence.
Private `.audit-evidence/backend-section-06r/` holds logs and reproducible probes.

The preceding checkpoint follows.

Section 6Q integrates the proven per-file limit into actual poster, rendition
and teaser runners. Local application regression fails before (13,007 bytes vs
2,048 budget), then passes on macOS and Linux (2,048 bytes, existing not-smaller
fallback, empty scratch). Real Linux normal/decode-failure/cancellation and
owner-death reclamation controls pass. Local web suite: 6,406 passed, 121 skipped;
focused final runner/capability checks: 59 passed; all three type projects pass.
Lint has no errors after excluding private generated evidence, two existing warnings.
Read `docs/audits/backend-section-06-encoder-output-limits-2026-10-02.md`.
PR #277 merged as a8dd6c1fa40a1a74d4f1f5115d611f830a8ced28 at 09:36:22 UTC.
PR Quality 36989530190 passed all four jobs first attempt: 6,407 web, 2,848 mobile,
19 browser, 1,941 SQL assertions, 122 DB checks (one child-harness skip), all real
FFmpeg checks and 163 native route traces. No mobile store release was active.
Exact-main Quality 36990750061 passed all four jobs. Standard production release
36991829551 succeeded on attempt 1 at 09:51:18 UTC (15:21:18 IST), including staged
and protected production health. Independent live exact SHA/feed 200/admin 307/
unsigned webhook 401 pass; remote main matches a8dd6c1f. Runtime
capability is measured asynchronously once per process; unavailable enforcement
fails closed. No production media transaction has yet verified this launcher.
MEDIA-06 shared capacity reservation and MEDIA-07 legacy metadata policy remain
open; scoped ledger stays 21 passed, 27 untested, 2 failed, 3 external.
Private evidence `.audit-evidence/backend-section-06q/`. Preserve unrelated local
receipt edits, Section 1 files, and all prior evidence. Current verified live is a8dd6c1f.

Release details: `docs/audits/backend-section-06-encoder-output-limits-release-2026-10-02.md`.

Section 6R has reproduced the next shared-capacity failure on this exact merged
runtime: one bounded rendition succeeds on a 10.5 MiB tmpfs, while two concurrent
bounded renditions with retained sources/outputs both hit real ENOSPC below their
individual caps. Both sources remain byte-identical, a separate parent-process
sweep reclaims zero live workspaces, and both worker paths eventually clean up.
Barriers deliberately overlap staging/retention; this is not a production-load
claim. Read `docs/audits/backend-section-06-bounded-writer-contention-2026-10-02.md`.
No new 6R runtime change. Private `.audit-evidence/backend-section-06r/` contains
reproduction, final source-integrity assertions and hashes. Next: implement and
prove shared atomic admission, including remaining-growth vs retained-byte
accounting, block/metadata headroom, inherited child claims, abort/death cleanup
and malformed/legacy state. The private 6Q `next-capacity-boundary.md` lists the
seven writer allocations and important failure cases. Preserve these local
release/reproduction documents for the next PR. MEDIA-06/07 remain open.

The preceding checkpoint follows.

Section 6P kernel output-bound proof passes locally on macOS/Node 22/FFmpeg 6.0
and Linux/Node 24/FFmpeg 8.1.2. No runtime integration or deployment yet. Read
`docs/audits/backend-section-06-kernel-output-bound-2026-10-02.md`.
A fixed positional-argument shell launcher applies the kernel file-size limit
before exec. Outputs stop exactly at 4 KiB/64 KiB with SIGXFSZ; normal 1 MiB-budget
encodes succeed. The cap and both leases survive parent death beyond the Node
timeout; a fresh process reclaims both workspaces only after FFmpeg exits.
Shell units differ: measured Mac 1024 vs Alpine 512 bytes. Do not assume one unit
or call this aggregate admission: two files can each consume the per-file cap.
Next: verify production launcher capability/units and explicit output budgets,
then integrate/test actual runners and shared cross-process reservation, including
completed source accounting and metadata headroom. No age-based legacy deletion.
Private evidence `.audit-evidence/backend-section-06p/`; scoped ledger unchanged.
Current branch/main baseline and verified production remain 626f398c; preserve
uncommitted 6N release, 6O/6P evidence and unrelated edits.

The preceding checkpoint follows.

Section 6N is merged in PR #257 as 149b9edc39c4ab895f049b270e86bdff960b1b95
at 2026-10-01 14:17:15 UTC. Updated PR Quality 36873464662 passed all four jobs;
6,178 web tests, real FFmpeg media scratch/cancellation and 163 native artifact
traces passed. Initial Quality 36872492921 exposed child TSX cache files in the
probe scratch root; e2f5b6b2 isolates that cache without runtime changes. Both
results are preserved. No mobile store release was active before merge.
Exact-main Quality 36875154079 passed all four jobs first run. Standard release
36876633477 succeeded first attempt October 1 at 14:31:58 UTC (20:01:58 IST),
including staged/protected production health. On October 2, remote main and live
production are 626f398c, including #257 and 15 later PRs. Audit checkout fast-forwarded
without conflict; all local evidence and unrelated edits remain. Scratch runtime
and process probe are unchanged by the later PRs. Current release 36975169861
succeeded at 06:49:45 UTC (12:19:45 IST). Independent live SHA/feed 200/admin 307/
unsigned webhook 401 passed on this newer build. No stale deployment required.
Read `docs/audits/backend-section-06-media-scratch-release-2026-10-01.md` and
`docs/audits/backend-section-06-media-scratch-2026-10-01.md`.

Real Linux/Node 24 FFmpeg regular-file probes reproduce unreclaimed source/output
in all five old namespaces. Committed process regression fails before (0 vs 2
reclaimed), then passes for poster/rendition/teaser with inherited source/output
leases. Abort ordering also reproduced EBUSY and is fixed by waiting for close.
New work uses existing staging authority; old scratch and unpublished metadata
remain untouched. MEDIA-07 remains failed/open for legacy policy. Ledger: 53
obligations, 21 passed, 27 untested, 2 failed, 3 external.
Private evidence `.audit-evidence/backend-section-06n/`; 6L/6M reports are committed
in #257. Preserve uncommitted 6N release records and unrelated local files. Next:
shared disk admission/output bounds and metadata policy, followed by WORKFLOW-02/03/04.
October 2 compatibility check: 194 focused media/import/notification tests and all
nine actual isolated-DB worker-kill cases pass on current main. Separate readback
found zero audit-crash generations/import/completion jobs. Section 6O local
candidate output-limit probe shows FFmpeg -fs is not a strict byte ceiling:
16 KiB cap produced 266,960 bytes before exit 187. Current runner rejects that
failure; do not claim successful truncated output or Linux behavior. No runtime
change in 6O. Read `backend-section-06-current-baseline-output-limits-2026-10-02.md`.
Private evidence `.audit-evidence/backend-section-06o/`. Next: prove enforceable
output bounds before shared cross-process reservation. Preserve newer product
and notification changes; do not rerun an old deployment.

The preceding investigation checkpoint follows.

Section 6M actual disk-failure recovery investigation is complete locally; no
runtime change or release in this batch. Read
`docs/audits/backend-section-06-capacity-recovery-2026-10-01.md`.
A Linux/Node 24.21.0 container with 2 MiB tmpfs ran actual staging, import queue,
reconciliation/reaper, notification code and real isolated Postgres settlement.
Four scenarios pass: one ENOSPC then retry; first output uploaded/second ENOSPC
then full-list retry; ten ENOSPC failures then callback reconciliation; ten failures
then stalled reaper reconciliation. Across 22 actual disk failures, the original
120-credit reservation stays (500 -> 380 total, 200 -> 80 promotional); no premature
success/refund or notification. Recovery succeeds with one notification and no
second charge; duplicate enqueue/processing is stable. Partial list makes three
upload calls by reuploading its first path with the existing upsert option.

Media/provider responses and the local Storage sink are synthetic boundaries;
queue/ledger/staging are real. No external push/Storage/provider delivery or
FFmpeg is certified. Retry eligibility and reaper age were advanced on fixture
rows, not by waiting out production timing. Exhausted imports are not claimed
merely because capacity returns; callback or reaper reconciliation reopens the
same job. No speculative stranded-credit fix is warranted by these results.
All transactions rolled back, fixture users were checked, separate readback found
zero probe generations/jobs, and dedicated probe resources were removed. Existing
DB containers and unrelated local changes are preserved. Private evidence:
`.audit-evidence/backend-section-06m/` (including reproducible probe and hashes).

MEDIA-06 remains failed/open for shared capacity admission; recovery evidence does
not prevent ENOSPC. Ledger unchanged: 53 obligations, 21 passed, 28 untested,
1 failed, 3 external. Next: measure overlapping source/output bytes and actual
owner/writer lifetimes for generation-poster, generation-frame, feed-rendition-src,
feed-rendition and feed-teaser before designing cross-namespace reservation or
cleanup. Then continue WORKFLOW-02/03/04. Preserve the local 6L release documents
and 6M report for the next audit PR. Production remains `999c34d5` (Section 6L).

The preceding deployed checkpoint follows.

Section 6L is merged in PR #256 as `999c34d5b3435d160865a05c8ba3ff1bd3a0ec29`
at 2026-10-01 12:35:45 UTC (18:05:45 IST). Exact-main Quality `36862814234`
passed all four jobs first run. Standard production release `36864062596` passed
attempt 1 at 12:50:32 UTC (18:20:32 IST), including staged and protected production
health. Independent live build `999c34d5`, feed 200, admin login redirect 307 and
unsigned webhook 401 passed; remote main still matches. Section 6L is deployed
and verified; no release work remains pending. Read
`docs/audits/backend-section-06-scan-progress-release-2026-10-01.md`.
MEDIA-05 is passed: 53 checklist obligations now contain 21 passed, 28 untested,
1 failed and 3 external. These counts are not a completion percentage.
PR Quality `36853752909` passed all four jobs on its first run: 6,176 web,
2,802 mobile, 19 browser, 1,941 SQL assertions and 119 DB checks. Real FFmpeg
lease and native packaging checks passed. No mobile-store release was active
before merge.
Read `docs/audits/backend-section-06-scan-progress-2026-10-01.md`.
A new actual-filesystem/fresh-process regression fails before the fix (0 instead
of 2 reclaimed). The pass now caps successful reclamations at 128 instead of
examined entries, preserving the lease/marker authority checks. An early marker
metadata check rejects unpublished entries before opening a lease; it is not
sufficient deletion authority. No cursor state or new dependency is introduced.
Directory validation is now linear, not capped at 128 entries or time-bounded;
that explicit latency tradeoff is measured locally and metadata accumulation
remains open. Local 2 MiB Linux/Node 24 probe reclaims the two blocked owners and
allows the next import, preserving all 128 unpublished fixtures and active readers.
Three new regression cases cover unpublished/locked prefixes and a 140-owner
backlog across fresh processes. 23 focused tests, 6,176 full web tests (118 skips),
app/test typing and targeted lint pass. The focused cases were rerun after the
marker precheck; exact final-tree CI remains the release gate.
Preserve `.audit-evidence/backend-section-06l/` and the 6J/6K local documents.
No SQL/mobile change. Next: actual ENOSPC through import retry and settlement,
then shared admission and other scratch lifetimes. Read private
`.audit-evidence/backend-section-06l/next-capacity-boundary.md`. Keep Section 6L
release records local for the next audit PR; unrelated changes remain preserved.
Production is `999c34d5` (Section 6L).

The preceding investigation checkpoint follows.

Section 6K bounded disk-pressure investigation and first completion ledger are
complete locally. No runtime change, PR or production release was made in 6K;
production remains verified Section 6J (`5934bd7d`). Read
`docs/audits/backend-section-06-disk-pressure-2026-10-01.md` and use
`docs/audits/backend-audit-completion-checklist.md` as the closure ledger.
The surface map captures 162 routes, 201 services, 323 public functions,
136 public relations and 12 jobs; every route has a review group. Seven page-only
services and eight indirect RPC sites were traced. SQL/trigger/other entrypoint
behavior reconciliation remains MAP-02; do not turn inventory counts into audit
completion percentages.

Actual Linux/Node 24.21.0 probes used a 2 MiB tmpfs, native fs-ext and no network.
Five sequential worker kills no longer accumulate staged files within the scan
window. Active owners and an inherited reader retain intact bytes under ENOSPC;
failed new staging is cleaned. Two remaining obligations were reproduced:
MEDIA-05: 128 unpublished entries in actual iteration order block two trailing
dead owners through ten scans, retaining 1,843,200 reclaimable bytes and causing
new staging ENOSPC. Removing only the known empty test fixtures lets the same
sweeper reclaim both. MEDIA-06: two workers each observe 2 MiB free before a
barrier, then request 1,228,800 bytes each; one succeeds, one gets ENOSPC, and
cleanup succeeds. A space observation is not a shared reservation. These are
local fault-injection results, not production incidents or provider delivery proof.

Next: resolve MEDIA-05 with bounded progress across calls and restarts, preserving
active readers/unpublished metadata. A larger limit or process-local cursor alone
does not close it. Evaluate durable progress versus full-enumeration latency
explicitly before changing cleanup. Then shared admission/other scratch owners,
followed by workflow execution/recovery. Preserve
`.audit-evidence/backend-section-06k/` and the new local documents. Both probes
passed their assertions, including reproducing the open failures; no runtime
tests were rerun for documentation-only changes. The dedicated probe containers
and image were removed; existing database containers were untouched.

The preceding deployed checkpoint follows.

Section 6J inherited staging leases/reclamation is implemented and locally
verified; full web suite passed (6,173 tests). PR #255 head
`285b39468f6a98219e6e4d7c1ee38ce6fac9aedb`. First Quality `36809462816`
passed runtime tests, real FFmpeg, mobile, browser and DB but caught a test-worker
mkdtemp overload cast in test typing. Follow-up commit fixes the wrapper; local
test typing, all 14 workspace cases and lint pass. Updated PR Quality
`36810222612` passed all four jobs, including 6,173 web, 2,802 mobile, 19 browser,
1,941 SQL assertions and 119 DB checks. Actual FFmpeg inherited-lock and native
packaging checks passed. No mobile store release was active before merge.
PR #255 merged as `5934bd7dac80d402d4db5e274e2716a60432790a` at October 1,
04:31:36 UTC (10:01:36 IST). Exact-main Quality `36815532624` passed all
four jobs first run. Standard production release `36816387424` attempt 1
promoted successfully and verified public live SHA, but its final protected
health response reported a mismatched build ID. Independent SHA/feed/admin/
unsigned-webhook checks pass. The unchanged failed release job passed on attempt 2,
including staged and protected production health, completing October 1 at
04:50:53 UTC (10:20:53 IST). Independent checks repeated afterward confirm live
`5934bd7d`, feed 200, admin login redirect 307 and unsigned webhook 401; remote
main still matches. The first failure is preserved; its cause is not established
because the log omits the actual mismatched ID. Section 6J is deployed and verified.
Read `docs/audits/backend-section-06-staging-locks-2026-10-01.md` and
`docs/audits/backend-section-06-staging-locks-release-2026-10-01.md`.
118 focused tests and all nine database worker-kill cases pass. Actual FFmpeg
lease inheritance passes on macOS/Node 22 and Linux/Node 24; an independent Linux
workspace probe reclaims dead owners and preserves active bytes. App/test/script
typing, targeted lint, production build and native artifact checks pass. CI now
runs the real FFmpeg lease probe. Preserve `.audit-evidence/backend-section-06j/`.
New workspaces use inherited fs-ext locks and bounded published-only reclamation;
legacy/unpublished/foreign workspaces and other scratch namespaces are untouched.
No migration/mobile change. No Section 6J release work remains pending. Preserve
the local release records for the next audit PR. Next: bounded disk-pressure
reproduction, scan fairness beyond 128 entries and other scratch lifetimes; see
`.audit-evidence/backend-section-06j/next-disk-boundary.md`. Protected release
health does not constitute a synthetic production media/lock transaction or close
the broader audit and outstanding operator moderation review.
The preceding investigation checkpoint follows.

Section 6I local reader-lifetime investigation is complete; no runtime fix has
been implemented and no release is pending for this evidence-only batch. Read
`docs/audits/backend-section-06-reader-lifetime-2026-10-01.md`.
The actual FFmpeg helper with an isolated FIFO retained a live child 31,521 ms
after parent-only SIGKILL; the live-parent control killed its child at 30,005 ms.
The repeatable script `scripts/audits/audit-video-poster-owner-lifetime.ts` exits
1 when the finding reproduces; script typing/lint pass, and all fixture readers
and files were removed. This is macOS/Node 22 fault injection, not a production
incident or evidence that provider media can trigger a hung decoder. No safe
cross-worker sweep has been established. A separate Linux/Node 24 inherited
`flock` prototype denied reclamation while the orphan reader held its descriptor,
allowed the delayed 614,400-byte read, then allowed exclusive cleanup after the
reader released it. Corrected rerun has no stderr. This generic reader proof is
not FFmpeg integration or a production utility/packaging guarantee. Next: verify
production-compatible lock packaging and add reader/publication race tests before
wiring cleanup. Never explicitly unlock the shared description while a child can
hold it. Keep disk admission a separate obligation. Private evidence: `.audit-evidence/backend-section-06i/`.
The Section 6H release records remain local for the next audit PR. An unrelated
edit to `backend-section-05-receipt-identity-2026-09-29.md` was present at the start
of 6I and remains untouched. The latest deployed checkpoint follows.

Section 6H staging lifecycle fix is merged in PR #254 as
`bc2fc0976196d996fba2fcca25d399cb60f9049f`. PR Quality `36804520935` passed
all four jobs on its first run. Exact-main Quality `36805280456` also passed
all four jobs first run: 6,159 web, 2,802 mobile, 19 browser without retry,
1,941 SQL assertions and 119 DB checks (64 generation). Standard production
release `36806100925` succeeded October 1 at 02:33:12 UTC (08:03:12 IST).
Independent live SHA `bc2fc097`, feed 200, admin login redirect 307 and unsigned
webhook 401 passed; protected staged/live health passed in the workflow.
No mobile store release was active before merge. Section 6H is deployed and
verified; no release work remains pending. Read
`docs/audits/backend-section-06-staging-cleanup-release-2026-10-01.md` and preserve
these local release records for the next audit PR.
Read `docs/audits/backend-section-06-staging-cleanup-2026-10-01.md`.
Three real-filesystem regressions reproduced: failed cleanup could falsely succeed
on retry; concurrent callers returned before deletion; allocation failure left an
opened source uncancelled. Fix shares the deletion promise, permits retry after
failure and cancels the source on allocation error. All 102 focused tests and
25 DB output/crash checks pass, as do app/test typing and lint. Real HTTP source
cancellation and permission-failure retry probes pass. No migration/mobile change.
A separate bounded 2 MiB tmpfs probe confirms SIGKILL accumulation can cause ENOSPC
if scratch survives worker replacement. That obligation remains open: no owner-
unsafe stale sweep was added, and no production retention/incident is asserted.
Private evidence: `.audit-evidence/backend-section-06h/`. Next: establish safe
owner/preview-reader lifetime before cross-worker reclamation; read private
`next-owner-lifetime.md`.
A separate parent-only SIGKILL probe confirmed its child survived and read the
staged file 1.5 seconds later; this generic reader is not an ffmpeg measurement.
The preceding live checkpoint follows.

Section 6G merged in PR #253 as `d848cd2d71b9f35b2d174b83f0906b5e8a57db55`.
PR Quality `36774458575` passed after an unchanged failed-job rerun: the first
browser job failed on composer navigation destroying its page context; the second
passed. Web/mobile/DB jobs passed initially: 6,153 web, 2,802 mobile, 1,941 SQL
assertions and 119 DB checks (64 generation, including nine process-kill cases).
No mobile store release was active before merge. Exact-main Quality `36775733672`
passed all four jobs on its first run, including all 19 browser cases without
retry. Standard release `36776882155` succeeded September 30 at 21:06:59 UTC
(October 1, 02:36:59 IST). Independent live SHA `d848cd2d`, feed 200, admin login
redirect 307 and unsigned webhook 401 passed. Section 6G is deployed and verified;
no release work remains pending. Read
`docs/audits/backend-section-06-worker-crash-release-2026-10-01.md` and preserve
these local release records for the next audit PR.
Read `docs/audits/backend-section-06-worker-crash-2026-10-01.md`.
Nine actual SIGKILL cases pass with fresh-process recovery and real reservation,
lease, settlement and notification SQL; all 64 generation DB checks pass together.
Actual HTTP kill/restart probes cover before-dispatch refund and accepted-task
callback/replay, preserving total/promotional credits with zero/one provider calls.
No new runtime defect or production patch; these regressions now run in DB CI.
Test typing/lint pass. No migration/mobile runtime/OTA. Staging files left by
SIGKILL are recorded as an open cleanup/disk-budget boundary, not silently fixed.
Private evidence: `.audit-evidence/backend-section-06g/`. Next: assess stale
staging-file cleanup with active-file/ownership protections; read private
`next-staging-cleanup.md`. Genuine provider/edge delivery remains unverified.
The preceding live checkpoint follows.

Section 6F merged in PR #252 as `1eb94f13a303d28f4071f1772efd7caf90378673`.
PR Quality `36729025150` passed all four jobs first attempt: 6,153 web,
2,802 mobile, 19 browser, 1,941 SQL assertions and 110 DB checks (55 generation).
No mobile store release was active before merge. Exact-main Quality `36730702272`
passed all four jobs first run. Browser results were 18 passed plus one flaky
public-search empty-state check passing its automatic retry. Standard production
release `36731984597` succeeded September 30 at 14:58:19 UTC. Independent live
checks resumed October 1: SHA `1eb94f13`, feed 200, admin login redirect 307,
unsigned Kie webhook 401. Section 6F is deployed and verified; no release work
remains pending. Read
`docs/audits/backend-section-06-marker-recovery-release-2026-10-01.md`.
Preserve local release docs for the next audit PR.
Read `docs/audits/backend-section-06-marker-recovery-2026-09-30.md`.
Twelve start and three reaper DB regressions reproduced before implementation;
actual HTTP reproduced refund/ignored callback. The fix retries marker writes,
preserves unconfirmed holds and request keys, and restores missing markers before
expiry refund. Persistent outages use cautious public copy and defer reaper
settlement. All 183 focused web/DB and 120 mobile contract cases pass; app/test/
mobile typing and lint pass. HTTP transient/persistent retests preserve one hold
and one provider call through callback and same-key replay. No migration or OTA.
Private evidence: `.audit-evidence/backend-section-06f/`. Production read-only
counts remain unchanged; no customer repair. Next: actual worker termination;
see private `next-worker-termination.md`.
The preceding live checkpoint follows.

Section 6E merged in PR #251 as `d5d71fba5f367af836e52454a0a549f79ff87dbd`.
PR Quality `36719881177` passed all four jobs first attempt: 6,150 web tests,
2,801 mobile tests, 19 browser tests, 1,941 SQL assertions and 95 DB checks
(40 generation recovery). No mobile store release was active before merge.
Exact-main Quality `36720852933` passed all four jobs on its first attempt.
Standard production release `36721626640` succeeded at 2026-09-30 13:29:34 UTC.
Independent live SHA `d5d71fba`, feed 200, admin redirect 307 and unsigned webhook
401 passed. Protected staged/live health passed in the workflow. Section 6E is
deployed and verified; no release work remains pending. Read
`docs/audits/backend-section-06-start-recovery-release-2026-09-30.md`.
Preserve local release docs for the next audit PR.
A successful HTTP
creation response without a usable task receipt now enters the existing
ambiguous-submission hold rather than refunding and discarding a later callback.
Six failures reproduced against actual local SQL before implementation. Signed
local start/callback HTTP changed from 500/refunded/ignored callback to
409 submission_pending, callback processing, and same-key 200 replay with one
provider call and one hold. Fourteen DB cases include overlapping same-key
starts, template recovery, lost response and early callback orderings. All 136
focused web/DB checks, 133 mobile checks, app/test/mobile typing and lint pass.
Read `docs/audits/backend-section-06-start-recovery-2026-09-30.md`; preserve
`.audit-evidence/backend-section-06e/`. No migration or mobile runtime change.
Production aggregate has seven unmarked refunded starts without tasks, zero
marked ambiguous and zero active taskless rows; no attribution or repair.
Next: ambiguity-marker write failure/lost response, then worker
termination. The following is the preceding deployed checkpoint.

Section 6D is merged in PR #250 as `8a9eda28810066815efafeb5c0feff93dcd48b5f`.
PR Quality `36711122063` passed all four jobs on its first attempt: 6,150 web,
2,800 mobile, 19 browser, 1,941 SQL assertions and 81 DB integration checks
(26 generation recovery). No mobile store release was active before merge.
Exact-main Quality `36712301682` passed all four jobs on its first attempt.
Standard production release `36713364805` succeeded at 2026-09-30 12:16:38 UTC.
Independent live SHA `8a9eda28`, feed 200, admin redirect 307 and unsigned webhook
401 passed; protected staged/live health passed in the release workflow.
Section 6D is deployed and verified. No release work remains pending. Read
`docs/audits/backend-section-06-grace-recovery-release-2026-09-30.md`.
Release docs remain local for the next audit PR; preserve them.
It fixes acknowledged
loss of late-callback reconciliation when the database write fails or returns an
unconfirmed result: the callback now returns 503 until a record or benign no-op
is confirmed. Five failing real-DB cases and an actual signed local HTTP request
reproduced the defect before implementation. All ten new DB cases now pass,
including strict 45-minute selection and both callback/reaper orderings. Signed
HTTP after-fix results are 503/200/200 with one reconciliation and no second
refund. No migration or mobile runtime change. Read
`docs/audits/backend-section-06-grace-recovery-2026-09-30.md` and preserve
`.audit-evidence/backend-section-06d/`. Production read-only aggregate has zero
marked/refunded ambiguous generations and zero reconciliation rows. No repair.
Next: start-route idempotency and lost provider creation response, including
failure to persist the ambiguity marker; then worker crash recovery. Read
`.audit-evidence/backend-section-06d/next-start-recovery.md`. The following is the prior live checkpoint.

Section 6C is deployed and verified. PR #249 merged as
`5009ce0c858bffca7671d3a4c52f51118e6fbf6d` (preceding live build). PR Quality `36706988869`
and exact-main Quality `36708125072` passed all four jobs: 6,150 web tests,
2,800 mobile tests, 19 browser tests, 1,941 SQL assertions and 71 DB integration
checks (16 generation recovery). The initial PR run caught three outdated inline
settlement assertions; `850e2433` updates the actual route-export tests and
service-role boundary guard. No mobile store release was active before merge.
Standard release `36709175421` succeeded at 2026-09-30 11:36:08 UTC; protected
health and independent live SHA/feed 200/admin redirect 307/webhook 401 passed.

Video, Veo and motion polling now queue durable output imports, stay processing
through storage errors, and notify success after import settlement. No migration
or mobile runtime change. Read the finding and release reports:
`docs/audits/backend-section-06-durable-polling-2026-09-30.md` and
`docs/audits/backend-section-06-durable-polling-release-2026-09-30.md`.
Private evidence: `.audit-evidence/backend-section-06c/`. Production inventory:
12 successful video rows, zero external output URLs, no active video rows;
no repair performed. All synthetic local generation fixtures are removed.

Next: ambiguous submission grace expiry and late callback/reaper races using
real local PostgreSQL and actual service selection. Read the remaining obligation
map in `.audit-evidence/backend-section-06c/remaining-generation-obligations.md`.
Preserve local release evidence for the next audit PR. Section 6B evidence was
committed in #249; the preceding checkpoint follows.

Section 6B is deployed and verified. PR #248 merged as `999e09c4d1e14a1e8112148c2f57ea19e70a21a6`.
PR Quality `36675212554` passed all four jobs: 6,150 web tests, 2,786 mobile tests,
19 browser tests, 1,941 SQL assertions and 65 DB integration/concurrency cases.
The first PR run `36674721423` passed runtime tests but caught an overly broad
upload-mock type in the new test; commit `4f9e25c5` fixes its declaration.
No mobile store release was active before merge. Exact-main Quality `36676000337`
passed all four jobs on its first run. Standard production release `36676774311`
succeeded at 2026-09-30 06:12:42 UTC, including exact live SHA and protected health.
Independent verification on resumption found newer live main `3db9a9c7`, containing
6B unchanged plus community-policy changes. Live SHA/feed 200, admin redirect 307
and unauthorized webhook 401 passed. An actual signed local callback
with empty success output prematurely settled the generation and ignored later
valid output. Six real-DB regressions and seven polling regressions reproduced
before implementation. The fix retries incomplete worker results and keeps
image/video/motion status polling processing, with shared mobile contract tests.
After-fix signed HTTP recovery and import-retry checks pass. No migration or
mobile runtime change. Read `docs/audits/backend-section-06-empty-output-recovery-2026-09-30.md`
and `.audit-evidence/backend-section-06b/`. Production inventory: 88 succeeded,
one missing output already marked source-unavailable; no attributed incident or
customer repair. Section 5L/6A evidence is committed in PR #248.




Section 5L merged in PR #247 as `65890e3146309b5e62fac155f72983de4475a7a1`.
PR Quality `36670834114` passed all four jobs: 6,143 web tests, 2,783 mobile tests,
19 browser tests, 1,941 SQL assertions and 55 DB integration/concurrency cases.
No active mobile store release existed before merge. Exact-main Quality
`36671517379` passed all four jobs after an unchanged E2E-only rerun. The first
E2E attempt passed 18/19, with the composer reorder test losing its execution
context during navigation (same previously observed harness failure); attempt 2
passed 19/19. Both logs are preserved. Standard production release `36672523382`
succeeded at 2026-09-30 05:18:19 UTC. Independent live verification confirms
`65890e31`, public feed HTTP 200, and unauthenticated payouts redirecting to admin
login (307). Section 5L is deployed and verified; no release work remains pending.
Release evidence: `docs/audits/backend-section-05-payout-detached-reporting-release-2026-09-30.md`. See
`docs/audits/backend-section-05-payout-detached-reporting-2026-09-30.md`.
Three service failures and a real browser reproduction confirmed deleted-account
payout rows break mixed creator enrichment. The fix filters live IDs, retains
reconciliation identity, labels deleted creators and removes their dead links.
15 focused tests, app/test typechecks, lint and before/after Chromium checks pass.
No migration or customer repair is required; production payout inventory is empty.
Private evidence: `.audit-evidence/backend-section-05l/`.

While release CI runs, Section 6A initial local generation concurrency checks
passed: completion queue duplicate/claim/takeover/retry invariants and 20-way
failure, success and mixed settlement races. No new defect established; all
local fixtures removed. Read `docs/audits/backend-section-06-generation-recovery-2026-09-30.md`
and `.audit-evidence/backend-section-06a/`. Attachment SQL races also passed: task identity is exclusive and attachment
versus start-failure refund stays consistent. Next: cross-layer callback/start
handling and grace expiry, then import/worker crash recovery.

The watchdog's degraded moderation signal was independently reproduced by the
read-only production collectors: one open report is approximately 64 hours old,
exceeding the 24-hour SLO. Costs carry only `UPLOAD_RECLAIM_WITHHELD` warning;
backend health is ok. The report is not identified as an audit fixture and needs
operator review at `/admin/moderation`; it was not dismissed. Local authenticated
ops HTTP remains unavailable, and the incident remains open.

Section 5K is deployed and verified (preceding release).
- PR #246 merged as `a3d8c25b`; an empty retry commit `b04ccb46cfecb042b8215e521e0633bc44b9cdf9` (identical tree) triggered exact-main CI after the original merge had no run for several hours. No workflow gates changed; no mobile store release was active before either main update.
- PR Quality `36620179778` and exact-main Quality `36666493565` passed all four jobs: 6,139 web tests, 2,783 mobile tests, 19 browser tests, 1,941 SQL assertions and 55 DB integration/concurrency cases.
- Standard production release `36667235304` succeeded at 2026-09-30 04:08:48 UTC, including staged and live protected backend-health checks.
- Migration `20260929191934_reject_conflicting_legacy_bundle_restores.sql` maps to production ledger `20260930040503`. Both deployed function digests match clean local replay; only the functions fingerprint changed. Advisors unchanged: 1 INFO / 37 WARN / 0 ERROR, no added/removed findings.
- Sequential production rollback controls passed 20/20 before and after; separate cleanup found zero fixtures. Legacy-bundle and contention reproduction is local/CI only. Production inventory had no noncredit receipts, so no customer repair was needed.
- Independent live build is `b04ccb46`; feed 200, unauthorized webhook 401. Authenticated TEST/provider delivery remains unverified because credentials are unavailable locally.
- Findings: legacy bundle restore ownership, mobile/web restore-versus-repurchase deadlocks and duplicate admin revenue reporting. Read `docs/audits/backend-section-05-mobile-lifecycle-reporting-2026-09-30.md` and its release report. Evidence is `.audit-evidence/backend-section-05k/`.
- Watchdog follow-up is documented in Section 5L above; the overdue moderation case remains an operator action.
- Shared area-level coverage tracker: `docs/audits/backend-audit-coverage.md`; detailed inventory-to-behavior mapping remains pending.

Section 5J is the preceding verified release (historical checkpoint):
- PR #245 merged as `0c473693a270890c334ce6745e706e25a3e35ad3`; deployed main is `041ff8a5cf3280c7438285e6eb4fd33cc615490f` (one empty CI retry commit, identical tree).
- Exact-main Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36615600319 — all four jobs passed: 6,136 web tests, 2,783 mobile tests, 19 browser tests, 1,922 SQL assertions and 50 database integration/concurrency cases.
- Standard production release: https://github.com/112kratoss/ugc-copy/actions/runs/36616927718 — succeeded 2026-09-29 19:10:56 UTC. Independent live build matches current main; feed 200 and unauthorized webhook 401.
- Migration `20260929163206_retain_mobile_adjustment_event_identity.sql` maps to production ledger `20260929190728`.
- Production rollback checks: 14/14 passed (7/14 baseline); separate cleanup found zero fixture users, receipts, products, credit adjustments and history rows. Deployed function digest matches local replay.
- Schema changes match the new private history table and modified function. Advisors remain 1 INFO / 37 WARN / 0 ERROR grouped lints; only the expected policy-free private-table INFO finding was added, with no new warnings.
- Authenticated TEST webhook was not run because its credential was unavailable locally. Real provider delivery remains unverified.
- GitHub's delayed push triggers recovered without changing workflow gates. No mobile store release was active before either main update. Do not repeat empty retry commits or treat the historical trigger delay as a current blocker.
- Full evidence: `docs/audits/backend-section-05-mobile-event-history-release-2026-09-29.md` and `.audit-evidence/backend-section-05j/`.

Section 5I is the preceding verified release (historical checkpoint):
- PR #244 binds shared credit events to the original transaction and reversal target. Mobile and Razorpay wrappers propagate unresolved results without consuming metadata or binding a payment; RevenueCat returns retryable 503 with durable telemetry.
- Live build: `17e47edc303588abd4fd3ad18b780378e7b2ba1c`.
- Production release: https://github.com/112kratoss/ugc-copy/actions/runs/36590989396 (success at 2026-09-29 15:35:45 UTC).
- Exact-main Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36589512045 (all four jobs passed).
- PR Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36588396734 (all four jobs passed): 6,135 web tests; 2,783 mobile tests; 19 browser tests; 1,885 SQL assertions; 47 database integration/concurrency cases.
- Production rollback probe: 11/11 checks passed (7/11 baseline). Separate cleanup found zero fixture users, profiles, transactions, receipts, intents or adjustments. All four deployed function digests match clean local replay.
- Only the functions schema fingerprint changed; advisors remain 1 INFO / 37 WARN / 0 ERROR. Production inventory had no RevenueCat adjustment rows and no detected inconsistent credit receipt bindings, so no customer repair was needed.
- Migration `20260929150256_bind_credit_adjustment_events.sql` maps to production ledger version `20260929153307`.
- Independent live SHA/feed/auth-boundary checks passed. Authenticated TEST webhook was not run because its credential was unavailable locally. Do not claim end-to-end provider delivery.
- The preceding Section 5H cash-event release evidence is committed in #244. Its migration maps to production ledger version `20260929145604`. Section 5G store receipt identity remains deployed; genuine sandbox receipts stay supported.
- Merged main also contains the independent Android OTA target-record commit `cdf31199`, preserved unchanged by this audit.

## Preserve these local files

Carry the new release evidence in the next appropriate audit PR:
- Section 5K release evidence is committed in PR #247.
- Section 5L release evidence and Section 6A initial concurrency report are committed in PR #248.
- Section 6B release evidence is committed in PR #249. Preserve Section 6C release evidence and private logs for the next audit batch.
- This handoff, the updated Section 5K finding report and coverage tracker.
- Section 5J release evidence was committed in PR #246; Section 5I evidence in #245.
- `.audit-evidence/` contains logs and provider/schema snapshots. Preserve it; do not blindly commit it. Section 5G `ledger-private.json` contains private input and must not be published.
- Existing untracked Section 1 release/follow-up files predate this work and remain untouched.

## Next investigation

Section 5I release evidence is in
`docs/audits/backend-section-05-credit-event-binding-release-2026-09-29.md` and
`.audit-evidence/backend-section-05i/`. Six SQL regressions, four database-backed
webhook regressions and six adapter regressions reproduced before their fixes.
An initial restore fixture used ignored `UNCANCELLATION`; the corrected
`REFUND_REVERSED` fixture was rerun against the original SQL and failed as expected.
Production probe results are saved before and after deployment.

Section 5J noncredit mobile event history is fixed, deployed and verified through PR #245. Read `docs/audits/backend-section-05-mobile-event-history-2026-09-29.md`
and `.audit-evidence/backend-section-05j/`. Fifteen baseline identity checks failed;
all 1,922 SQL assertions and three new concurrency cases pass. Production rollback
probe reproduced seven incorrect outcomes before the fix; all 14 checks pass after
deployment and no fixtures remain.

Section 5K closed the reproduced legacy restore ownership, mobile/web
restore-repurchase deadlocks and mirrored-order reporting bugs. Section 5L diagnoses the watchdog and fixes detached payout reporting. Its release is complete. Continue the remaining commerce lifecycle/payout gaps
and the Section 6A generation recovery matrix.
Use the coverage tracker to move next into generation/provider recovery. Actual provider-backed
purchase/refund delivery remains a separate gap. Build a single coverage tracker
before claiming an overall percentage.

Read `docs/audits/backend-section-05-receipt-identity-2026-09-29.md` and its release
report for Section 5G. The original Section 5F next-step note and Section 5G fault
probe logs are historical: their unsafe characterization assertions describe the
pre-fix behavior. Current regression tests are in
`src/__tests__/mobile-receipt-identity-database.test.ts` and run in Quality's DB job.
The user authorized the conditional prevention fix after the initial investigation;
the provider field transition remains unobserved. Preserve genuine App Review
sandbox receipts; client-declared sandbox bypass stays disabled in production.

## Overall coverage — not full sign-off

The user was told a rough 35–40% working estimate, not a measured coverage percentage. Section numbers became smaller fix batches and are not a reliable progress denominator. Build a single coverage tracker from route/service/RPC/job inventories before claiming a percentage.

Four original areas have substantial work, with residual gaps: authentication; database ownership/permissions; credits/payments/refunds; marketplace/creator earnings/payouts. Deployed reports live under `docs/audits/backend-section-*`.

Six major areas still need deeper behavioral coverage: generation/providers; workflow/template execution and recovery; media/storage/signing/retention; posts/feeds/moderation/community; jobs/cron/retries/operations; deployment recovery/backups/capacity. Earlier ownership checks cover only parts of these.

Auth follow-ups include disposable-account deletion and provider revocation, mobile Google deep links, JWT rotation, and CAPTCHA rollout compatible with installed clients. Native Apple sign-in, Chrome web auth and admin login/logout were verified in earlier work; do not repeat stale pending claims from the initial report.

## Release and testing rules

1. Fetch main and inspect local work; preserve evidence and unrelated edits.
2. Reproduce bugs before fixing at their actual layer. Use real Postgres for financial state/concurrency; no speculative fixes.
3. Standard `.github/workflows/production-release.yml` only: exact-main Quality, migrations, edge, stage, health, promote, live check. No manual deployment bypass.
4. Before merging main, verify no mobile-store-release run is active.
5. Create migrations with the pinned CLI. Ensure new filenames sort AFTER the latest applied repository migration, even if an earlier file has a future timestamp. #240 failed release on this exact issue. Use `.github/scripts/apply-supabase-migrations.mjs` `planMigrations` against the complete production ledger before release. Management API ledger timestamps can differ; map unique migration names correctly. Never rename/edit an applied migration.
6. Supabase project `ildfmhozpibwiopeavfg`. Read production through Supabase MCP/Management API; direct CLI/pooler connectivity is unavailable. Never print secrets.
7. Production tests use bounded lock/statement timeouts, isolated fixture IDs, explicit service-role calls and ROLLBACK, followed by separate cleanup queries. Local/CI only for contention tests.
8. Keep exact build, function digests, fingerprints and advisor before/after evidence. Do not call inventory coverage behavioral certification.

Local DB: Docker `supabase_db_magicbooklet-auth-section-one`, port 55322. CLI pinned to 2.75.0 on this Mac. `/tmp/magicbooklet-section2-db/supabase/config.toml` uses project_id `magicbooklet-auth-section-one`, ports 5532*, and symlinks migrations/tests into this checkout. Temporary files may disappear between sessions; reconstruct only this isolated config if needed. `open -a Docker` starts Docker if stopped. Do not reset the primary project's DB.

Commands (from active checkout):
- `npx --yes supabase@2.75.0 db reset --local --no-seed --workdir /tmp/magicbooklet-section2-db`
- `npx --yes supabase@2.75.0 test db --local --workdir /tmp/magicbooklet-section2-db`
- Node 24: `npx --yes --package=node@24 node ...`
- Integration DB URL: `postgresql://postgres:postgres@127.0.0.1:55322/postgres` (local fixture DB only).

GitHub run listings sometimes return stale data. Use exact commit check-runs or a specific run ID before inferring no run exists. Final #241 CI passed first attempt. Earlier #240 main E2E failed on a navigation-destroyed composer context and passed the unchanged failed-job rerun; retain that evidence.
