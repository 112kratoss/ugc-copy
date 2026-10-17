# Backend audit — session handoff

Updated 2026-10-10 (Asia/Kolkata). Read this first when continuing the section-by-section Magicbooklet backend audit.

> **Series closed 2026-10-18.** Codex's section-by-section backend audit ended with the 10-10 entry below, and Codex no
> longer runs on this repository. This file is kept as the record, not as live instructions: the checkout paths, the
> "current checkout" lines and the "next work" lines describe the state on 2026-10-10, and the `auth-section-one`
> checkout has been removed. Two corrections to that state: the 12Z retention migration
> (`20261010071057_skip_locked_operational_retention.sql`) is applied in production, since #436's production release
> succeeded on 2026-10-10 at 07:48 UTC; and PR #438 (13A) was closed unmerged on 2026-10-18, its patch and the stacked
> 13B commit kept outside the repository (the owner's `archive/codex-wind-down-2026-10-18/`).

## Workspace and authorization

Primary repository: `/Users/athuls/UGC copy/ugc-app`.
Active audit checkout: `/Users/athuls/UGC copy/auth-section-one` (reuse it; preserve uncommitted evidence).
Current checkout: `codex/backend-assistant-inputs-13a`, candidate
`23004e0723f3bf89ea4c4aef95119cef01ebeafa`, PR438 open and attached, stacked on
PR436's `codex/backend-template-run-auth-12y` branch. Do not merge438 into that
intermediate branch; retarget to main after436 release is independently verified.
PR436 remains frozen743, including25 identity controls,12Z retention fix and12V
release evidence. PR433 is independently verified on ec0e08db; main1f9bd76a's
Quality38033537640 still running. Retention migration12Z is UNAPPLIED production.
Existing user edits preserved.
Read the parent and repository AGENTS.md. The user authorized section-by-section audit, reproduction, fixes, verification, and deployment of completed batches. Production rollback fixtures are authorized. Do not charge providers, alter real customer balances, or run production contention/load tests as incidental probes. No new permission is needed for the already-authorized audit/release workflow. Do not spawn subagents unless newly authorized by applicable instructions.

## Exact checkpoint

### Newest continuation — October 10, assistant admission13A / release waits

Previous turn made concrete progress (25realAuth controls, reproducednullinput,
fix,17focusedtests,newPR438); notblocked. Main1f9bd76aQuality38033537640 has4/5
success,webBuildrunning atlastcheck. Standardnotyetready(latest1frun38034020527
skippedfromothertrigger). PR436 exact743Quality38033798081 islive:mobile/SQL/E2E
passed,webBuild/APIrunning. Preserveexistingretentionbaselineandguard; don't
rerunprepareormergeuntilfreshparentstandard+verification/candidateall5.

13A actualassistantAuth/PostgREST suite:state/message/apply/discard foreign,
unsigned,invalid identity12cases;9malformedbodies;owned100messageboundedordered
read;apply/discardduplicates/oppositeactions;stalerevision. Baselinecorrected
suite24pass1fail:JSONnullthrowsTypeErroratbody.content, actualnativeRequest/Auth.
Initialstaleproposalexpectationwaswrong:SQLdeliberatelydiscardsstaleproposal;
onlytestcorrected. Servicebodyunknown+nonobject400guardfixesnullbeforestate,
rateorcredits.25actualpass1.41s;17focusedpass;app/testtypes,scopedlint,diffpass.
Actualcleanupzero,unchanged500balances,noledgerentries,noexternalrequests.
NoDDL/providerrequest. Evidenceassistant-auth-*; reportbackend-section-13-assistant-request-admission-2026-10-10.md.

Commit23004e0723f3bf89ea4c4aef95119cef01ebeafa pushed; exactQuality38034258613
allfivejobsconfirmedRUNNING. PR438 openattached
https://github.com/112kratoss/ugc-copy/pull/438 . BASEisPR436branchbydesignfor
seven-file review/parallelCI. After436mergeANDindependentrelease,retarget438to
main,mergeoriginmainasneeded,exactchecks+noDDLbaseline/guard/standardverification.
No13Areleasebaselinepreparedyetbecause12Zreleasepending. Keep438frozen.
Localledger24passed24untested3failed2external:WORKFLOW04failed13A,JOB02failed12Z,
MEDIA07legacyretirement. Hostedidentity/provider/persistencefailure/billingmatrix
notcertifiedbythese25admissiontests. Noactive localtestfixtureorworker.


### Newest checkpoint — October 10, 07:12 UTC approval verified; 12Z candidate743

PR433 approval release FULLY verified: exactmainQuality38027773322 allfive,
standard38028486183 SUCCESS. Independentverify07:11:40UTC liveec0e08db,
existing schema/permissions unchanged,newfunction/grant matchcleanreplay,
112advisorsunchanged. Ledgeratomic_template_checkpoint_approval20261010054423
(source20261009163235; APPLIED NEVEREDIT). Publicsmoke200/200/307/401.
Boundedrollbackprobe07:12:00UTC PASS,independent7tablescleanupzero. Report
backend-section-12-template-approval-release-2026-10-10.md committed65a6eb96.
WORKFLOW02 returnsuntested; JOB02nowFAILED12Z,ledgerstill24/25/2/2.

12Y candidate80f allfiveQuality38027808527SUCCESS, butmergeguardcorrectly
refused mainadvanced to1f9bd76a09d3a14b32cb91fa338cc9c4261cbc95 via437.
Inspected20files:client safety/creator/reels/UI tests/design docs; no server,
DDL,AGENTS orreleaseworkflowchanges. Current1f mainQuality38033537640RUNNING;
needstandardthenindependentreadback beforemerge436. Do notbypassguard.

12Z reproducesactualSQL locktimeout inall5operational retention tables.
Newmigration20261010071057_skip_locked_operational_retention.sql (pinnedCLI)
adds orderedFORUPDATE SKIPLOCKED preservingpolicy/cap/grants/latestmodelcheck.
7actualcasespass (eachtable,alllocked,overlappingsweeps) +2migrationchecks.
Cleanisolated55332 replayPASS all2376SQL/112files;7+2oncleanreplayPASS1.01s.
Testtyping/scopedlint/diffPASS. Twoearlyfixturemistakesrecordedseparately;
realbeforeevidenceretention-lock-reproduction.log shows5locktimeouts. Exact
localfixturecleanupzero; failedimmutablemodelidentities5removedonlylocally.
Allprunesrollback/ancientfixturecutoff1901, no otherlocal/proddata deleted.
Noactivefixtures/testworkers.

Commit65a6eb96 plus merge1f => candidate74385eda0a4a17f940d4f0eda7a5ea5d2354cfa7.
Pushed toexistingPR436branch;title/bodyrewrittenfinalscope (oneDDL+12Ytests).
ExactQuality38033798081 RUNNING. Localbranch12Z;remotePRbranch12Y intentional.
Do notpushextradocsandrestartCI unlessnecessary.

retention-lock-release baseline CAPTURED onverifiedec0e08db andMUSTNOT be
preparedagain. Expectedfunction/grant2signatures fromcleanreplay, baseline
schema/advisors112,exactlyonependingnewmigration,nooutoforder,candidatehashes.
verify.cjs SHA,release-smoke.cjs SHA,probe.cjs SHA prepared. Localrollbackprobe
PASS;productionprobeNOTRUN. Probe checksnoexistingpre1901rows,threeexactjob
fixtures,service-rolecap/retry/activeprotection,ROLLBACK,separatecleanupzero;
no productionlock/contention. prepare-retention-lock.cjs preserved.
merge-guard.cjs STANDARD_ID pinscandidate743/Quality38033798081,main1f/
Quality38033537640 andrequiresfreshtemplate-approval-release/comparison.json
verifiedon1f; also schema/advisors/source/ledger/mobile checks beforemerge436.
Next: once1fmainQuality+standardSUCCESS, rerun12Vverify+smokeon1f (no need
repeatapprovalproductionprobe), then436guardaftercandidateCI. Aftermerge:
exactmainCI+standard,12Zverify+smoke+probe,report. Goalactive,notblocked.


### Release checkpoint — October 10, 05:31 UTC / PR433 merged; PR436 opened

PR433 exactcandidate985 Quality38027148902 allfiveSUCCESS. Existing mergeguard
passed fresh production/source/schema/advisors/live/main/mobile-release checks
and merged433 at05:31:03UTC as ec0e08dbf0df48ee5dd9b07ba50192a63baf2c70.
Evidence template-approval-release/merge-gates.json; guard exit0. Baselines
preserved. Exactmain Quality38027773322 RUNNING, standard not verified yet.
Next: await allfive exactmain checks and standard production-release success;
then run existing template-approval-release/verify.cjs SHA, release-smoke.cjs SHA,
and probe.cjs SHA in order. Production rollback probe requires successful
independent new-schema/live verification first. Record report and only then
resolve reproduced12V failure; broader WORKFLOW02 remains open.

12Y tests/report committedd6c8110c; mergedorigin/main locally withno sourcechange,
newhead80f514b4bb6c610d3999fc6e7cfbda6fb8a76699. Pushed andopened PR436:
https://github.com/112kratoss/ugc-copy/pull/436 (attached). Exactlysix changedfiles,
25localAuth/PostgREST/Storage casespass, testtyping/lint/diffpass. No runtimeorDDL.
KeepPR436 frozen forCI; don'tmerge it before verifying433's standardrelease.
User receipt diff unchanged; ownhandoff/privateevidence andoriginalSection1files
remainlocal. Noactive localtestworkers/fixtures. Goalactive, notblocked.


### Newest continuation — October 10, template HTTP identity controls

12Y local commit d6c8110c adds 25 actual Auth/PostgREST/Storage controls for
run GET/cancel/retry/approval: foreign/unsigned/invalid identities, real foreign
step IDs, signed image bytes, duplicate actions, terminal refusal and transport
failure/retry. All25 pass (9.19s); test typing/scoped lint/diff checks pass. No
runtime/schema fix. Sequential API CI step included. Initial21 pass and one
intermediate default-5s test timeout during actual SDK GET backoff are retained;
final bounded30s outage case passes. Evidence template-run-auth-*; report12Y.
Method inventory reconciled with released11Q/R/S and7K; no full row closed.
PR433 still frozen985, four of five Quality38027148902 jobs passed; API job
has reached stack teardown after its tests. No merge until allfive success.
Currentmain remains64bf; existing mergeguard and release baseline unchanged.
12Y not pushed/PR-created yet; it can follow433 without restarting433 CI.
Docker was restarted with existing isolated volumes; no reset. No active fixture
or local test worker. Original receipt diff SHA256 remains bb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc.


### Newest checkpoint — October 10, 05:19 UTC verification / current live64bf; refreshed433

12U/#431 allfive mainQuality37961087969 andstandard37962589617SUCCESS.
Independent6b39c0b7readbackpassed October9 17:03:58UTC. Public12S/T/Urelease
report committed7bbeb4d0 andnowincluded433. No migrationorcustomerrepair.
Mainadvancedvia#4327387be03, #4347ca0de6d, #43564bf7cdc. Inspectedlatest28files:
reportUI/mobile/clientchanges andpost-report-service self-report400guard; no
migration/workflow/AGENTSchange beyondprevious#432contractinventoryupdate.
Latest64bf7cdcb7e74ab67005de7c575173cf9d6e9b75 allfiveQuality37985943664SUCCESS,
standard37987301024SUCCESS. Independent12Uverify+smoke atOctober10 05:19:33UTC
passlive64bf/source/schema/advisors112unchanged and200/200/307/401. Theattempted
738readbackcorrectlyfailedLiveMismatchbecauseproductionalreadyadvanced; no
baselineoverwrite. Updatedcomparison.jsonnow64bf. Prior6bpublicreportretained.

PR433 candidatea829/Quality37963629572 allfiveSUCCESS beforemainadvancedagain.
Refreshedcandidate now **985ef9a633abdb0e7fb9f95dc550a09d49897070**, exactQuality
**38027148902RUNNING**. It includes latestmain64bf,unchanged12Vruntime/migration,
12R+12Uverifiedreports, and9newworkflowmanagedtests wired intoAPIjob. PRbodyupdated.
Currentbranch12Vfast-forwardedthrough12X (testcommit649a2ea6/latestmainmerge985).
KeepcandidatefrozenwhileCIruns; noextraPRfor12W/12X needed.

12Vbaseline WAS CAPTURED onverified6b beforemainadvanced: schema/advisors,
expectedtwofunction/grant signatures, exactlyonependingmigration/nooutoforder.
DoNOT rerunprepare-template-approval.cjs oroverwritebaselines. Its sourcehashes
stillmatchcurrent433;freshmergeguardverifies. MergeguardUPDATED forcurrent64bf,
Quality37985943664, candidate985/CI38027148902. Afterall5CIpassrun
`template-approval-release/merge-guard.cjs 37987301024`. It checksunchanged
baseline/schema/advisors, currentlive/main andnomobilestorereleasebeforemerge.
ThenexactmainQuality+standard,verify.cjs SHA,smoke,andboundedprobe.cjs SHA.
Probe requiresindependentlive/schemafirst. Migration remainsUNAPPLIEDproduction.

12Xactualworkflowmanaged controls NINE PASS29.48s; testtyping/lintFINALpass.
SevenHTTP503failures (workflowpending/heartbeat/missingheartbeat,due-template,
strandedworkflow/strandedtemplate,templateprune) persistfailedresults;healthy
retryrecordsskipped. Emptycaseandactualheldmanagedleasepreservespendingtemplate
job/owner,claimneitherqueue, exactfixturecleanupzero. No runtimefindingorfixedbug.
Initialwrongtablenameandmissingexplicitfixtureenqueuefailuresaretestsetup,
retainedinprivateworkflow-managed-first/final.log;complete.logisthepassingrun.
UseslocalrealPostgREST+SQL,externaloriginblocked;noclaimpaid-workexecutionorfull
leasefencing. CInewstepserialinAPIjob. Reportbackend-section-12-workflow-job-admission-2026-10-10.md.

Noactive localtestworkerorfixture. Onlyownhandoff/userreceipt/privateevidence/
originalSection1filesdirty. Receiptoriginalhashstillpreserved. Currentledger
24passed25untested2failed2external (WORKFLOW02 pending12V;MEDIA07legacyretirement).
Wholeauditactive; thiscontinuationmadeprogress,notblocked. Remainingfullscope
stillrequiresbroaderauth/provider/workflow/social/job/restore/capacityevidence.


### Newest checkpoint — October 9, after 16:42 UTC verification / 12R complete; 12U merged

12R/#429 is fully independently verified on0ad91678 at16:42:18UTC: standard
37960469877 SUCCESS, exactmainQuality37958955983 all5SUCCESS; testedreleasefile
hashes/schema/advisors112unchanged; actualnewhealthgate marker confirms exactSHA
success after1request. Publicsmoke200/200/307/401PASS. Report
`backend-section-12-release-health-gate-verification-2026-10-09.md` committed in
local12W asd35d2719; ledgerheadercurrent0ad committedfdbdac21. OPS04untestedagain.
Do notredothebaseline orclaimstale-IDproductionretry fromthisone-requestrelease.

12U/#431 baseline CAPTURED in `template-retry-resume-release/`, pinnedcandidate
1f5d85e3 runtime/migrationlist, noDDL. Guardpassedfreshgates andmerged431as
`6b39c0b7aadecfeefc2c137ec3809801c214abba` at16:42:46UTC. ExactmainQuality
37961087969 RUNNING. Needautomaticstandard, then existing verify.cjs SHA and
release-smoke.cjs SHA; no migration/prodfixture for12U. Do notrunprepareagain.
Its main tree is identical to includedcandidate1f5d85e3 (gitdiffemptyverified).
A watch for37961087969 was started; use authoritative exact-runstate ratherthan
assuming missing/ended local watch meansCIstopped. Logtemplate-retry-main-quality-watch.

Current12Wlocal includes433candidate952plus12Rreleasedocs andmergeofmain6b
(commit67c48e38). NoPRfor12W. PR433 remains952f1dcfec48769add158228f9991b48b56d6a24,
exactQuality37960737676RUNNING. Don'tpush12Wonto433 just torecorddocs whileCIruns.
OtheruserPR432 hide-rowwording wasopen; don'ttouchit. Guardwillrejectmainadvance.

12V future release setup COMPLETE but baseline NOT CAPTURED:
prepare-template-approval.cjs VERIFIED_PARENT_SHA requires12Ucomparison, reads
pinned952source/migrationlist andcleanDB55332function/grant. Expectedtwo signatures
confirmed: approve_template_checkpoint(uuid,uuid,uuid) andservice_rolegrant.
merge-guard.cjs STANDARD_RUN_ID expects6b/mainQuality37961087969 and433/37960737676.
It requires6b treeequal1f and1fancestor952, provingnewcandidatecontainsverifiedparent
contents withoutneedlesslyrestartingCIforapuremergecommit. Main/liveexact6brequired.
verify.cjs SHA checks newfunction/grantagainstcleanreplay, remaining schemaunchanged,
advisors, ledgerandruntime/migrationsource. ProbeSQL+probe.cjs requiresverifiedlive
schemafirst; localrollbackproofpassed andindependentcleanupzero in7tables.
Production inventorymatchingstrandedapproval=0; noactualproductionprobeorrepairyet.
Noappliedmigrationhasbeenedited. New12V migrationisUNAPPLIEDproduction.

Alllocaltestsfinished:49DBonbothstacks,265template,2376SQL112files,app/testTS/lint.
Currentledger24passed25untested2failed2external:WORKFLOW02(12U/12Vpending),MEDIA07.
12Wdocsnotpushed. Userreceiptstillhashbb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc.
No fixture or owned local worker remains. Full audit active; progressmade.


### Newest checkpoint — October 9, 16:43 UTC / 12V approval atomicity; 12R promoting

12R main0ad exact Quality37958955983 ALL FIVE SUCCESS. Standard37960469877
is RUNNING at protected production health after promotion. The earlier skipped
standard37960330390 is not the release. Next verify existing health-gate script
with0ad and37960469877, then smoke; preserve original baseline. Main watch41344
is obsolete now that exact Quality success is authoritative.

431 candidate1f5d85e3 Quality37959157884 ALL FIVE SUCCESS. The prepared
`prepare-template-retry-resume.cjs` now reads candidate source/migration lists
from that exact Git commit, so newer12V local work cannot contaminate its baseline.
Still NOT RUN until12Rlive independently verified. Capture, then run its existing
mergeguard with37960469877. Do not merge ahead of verified parent.

12V: two additional SQL-trigger regressions reproduce ignored run-resume errors
and committed approval checkpoints. Before logs `template-approval-sql-before.log`;
the earlier adapter-only first repro is also retained. New additive migration
`20261009163235_atomic_template_checkpoint_approval.sql` creates service-only
SECURITY INVOKER approval RPC, owned-run then step lock, current-attempt/output/
terminal checks, approval+resume+enqueue in one transaction. NOT APPLIED PRODUCTION.
Four actual local trigger fault cases cover run and queue rejection/rollback;
concurrent approval/retry/cancel/abandon still passes with stricter terminal refusal.
49actualDB cases PASS both local and clean-replayDB55332;265template tests PASS
(79environment-gated skipped explicitly not counted);2376pgTAP/112files clean
replay PASS;app/testtyping/lint PASS. Nofixturesremain. All local workers finished.

12V committed952f1dcf, pushedPR433attached. Quality37960737676RUNNING. Includes431
until431 merges; hold433merge for independently verified431. Current runtime/schema
fix is separate from431. Production count of awaiting_approval runs with all latest
checkpoints approved is ZERO (template-approval-inventory.json). No customer repair.

Private12V release setup: `prepare-template-approval.cjs VERIFIED_PARENT_SHA`
PREPARED NOT RUN; requires12U comparison first, uses pinned952 Git source/migration
list and local clean-replay function+grant signatures. verify/smoke/probe scripts
are prepared in `template-approval-release/`. Probe SQL uses bounded transaction,
service-role owned synthetic records, ROLLBACK and independent zero cleanup;
it PASSED LOCALLY on clean replay only. Production probe requires verified live
schema first. Need433 mergeguard after431 exactmain/standard IDs known. Do not
capture baselines before the proper parent or overwrite prior baseline files.

Current ledger remains24passed24untested3failed2external (WORKFLOW02,OPS04,MEDIA07).
WORKFLOW02 also includes12Vunreleased now; do not clear it just because431 ships.
The previous goal turn made concrete progress; this turn adds reproduced/fixed
approval failure evidence and clean migration proof. Whole audit stays active.


### Newest checkpoint — October 9, 16:29 UTC / 12R merged; 12U reproduced and fixed

PR #429 passed all five candidate Quality jobs (37957625786). Fresh release
merge guard passed schema/advisors/live/source/main/mobile checks and merged as
`0ad91678fa7030dfcc1ad5f54d015cd0eb1c5bd0` at 16:24:58 UTC. Exact-main Quality
37958955983 is running. Wait for its automatic standard release, then use existing
`production-health-gate-release/verify.cjs SHA STANDARD_RUN_ID` plus smoke. Baseline
is already captured; do not overwrite it. OPS-04 remains failed pending independent
verification, including the actual modified health-gate log marker.

12T adds two pre-submission SIGKILL cases: committed hold / zero provider calls,
lease takeover with no duplicate submission, stale reaper exact refund and one
notification, retry one new attempt, cancellation remains terminal. All 27 cases
passed, along with typing/lint. Committed as `4707d7d3`; report is in candidate.
Fixture timestamps are aged, provider/Storage boundaries controlled; do not claim
real elapsed TTL or external provider/Storage behavior from these tests.

12U then reproduced TWO real SQL-backed failures: generation retry ignores a
rejected run-resume write and returns success; repeating its original request
returns early and leaves the committed queued attempt in needs_attention.
`template-retry-resume-before.log` retains both failures. The service now checks
resume errors and lets a replay resume/enqueue its existing queued generation
attempt. Four new cases include missing-ticket restoration and cancellation.
45 database cases pass sequentially in26.46s, 58 focused cases pass, app/test
TS and lint pass. Initial parallel invocation of the two global-queue suites
failed due to fixture interference (another suite consumed the crash fixture);
its log is retained, corrected sequential invocation matches CI. No migration.

PR #431 https://github.com/112kratoss/ugc-copy/pull/431 is OPEN and attached,
candidate `1f5d85e36171cfe2388b759700f0827c3ba5c3e2`, exact Quality
37959157884 running. It includes local12S's13 actual profile-media controls,
12T,12U and verified12P report. 12S needs no separate PR. Local branch contains
main0ad via mergec38eff57. WORKFLOW-02 failed pending12U release; current candidate
ledger24passed24untested3failed2external. Broader workflow scope remains open.

Private `prepare-template-retry-resume.cjs` PREPARED NOT RUN; expects verified0ad
live and captures unchanged-schema baseline plus one template-runtime hash.
`template-retry-resume-release/verify.cjs SHA` and smoke are prepared. Need
mergeguard with431candidateCI and verified0adQuality/standard IDs after baseline.
A bounded read-only count of needs_attention runs with latest queued generation
retry returned zero; private template-retry-inventory.json retains the timestamp.
No production repair was needed. The431 merge-guard is prepared and takes the
verified0ad standard run ID as its first argument; never run before parent verification.

Main Quality watch for37958955983 is active as exec session41344, logging
production-health-gate-main-quality-watch.log. No release run ID yet; inspect
exact commit0ad workflows after main Quality. Candidate431 CI37959157884 active.
Only own handoff, user receipt, private evidence and original Section1 files
remain outside commits. No active local test worker/fixture remains; both suites
finished, per-case cleanup readback passed. Whole audit remains active.


### Newest checkpoint — October 9, 16:22 UTC / profile release verified; template recovery controls

Current main `a4fb1d9ee6d803c74f6191984e3f7e390755f0b5` passed all five Quality
jobs (37945161319) and standard release 37946668616. Independent 12P verification
at 16:14:05 UTC confirms live identity, four runtime hashes, unchanged schema and
112 unchanged security findings. Public smoke 200/200/307/401 passes. Public
12P release report is committed in local 12S as `4f1127ac`; SOCIAL-04 returns to
untested. Ledger is 24 passed / 25 untested / 2 failed / 2 external (53 total).

PR #429 remains OPEN at `90b9fcb018d2886fb51a74c6d7e5438934df4905`, exact
Quality 37957625786 running (three jobs passed at this checkpoint). Its release
baseline HAS BEEN CAPTURED in private `backend-social/production-health-gate-release/`;
do not rerun the generator or overwrite baseline files. `merge-guard.cjs` checks
this candidate/CI against verified a4 main and merges only after all five pass.
After main Quality/standard, `verify.cjs SHA STANDARD_RUN_ID` requires actual
modified protected-health-gate execution proof; then `release-smoke.cjs SHA`.
OPS-04 stays failed until that release is independently verified.

Local 12S's five additional rate/admission controls (13 actual profile-media cases)
remain in history; no PR yet. Current 12T extends the template worker death suite
at the committed credit hold before any provider dispatch. The first run passed
26 cases; test typing/lint passed. A further cancellation-before-reaping control
is now running, so do not claim that added case passed yet. No runtime or schema
change established. Worker/provider/Storage boundaries and fixture timestamp
aging must be disclosed; these tests do not make real provider calls or prove
elapsed wall-clock TTL. Docker is healthy; no reset was needed this resumption.

Receipt diff SHA256 is still
`bb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc`.
The user's two original untracked Section 1 files are preserved. Continue the
full audit; no full-completion claim or current external blocker established.


### Newest checkpoint — October 9, 13:00 UTC / main advanced through Android menus

Otheruser#428merged **791a5ce659d17c3a06700be2d699c8b9db952450**. Inspected19
changedpaths:Androidmenus/docs/tests only; noAGENTS/backendruntime/migration/
releaseworkflowchanges. #427'smainQuality37933118860CANCELLEDsuperseded; do not
rerun4ca. CurrentmainQuality **37933416612RUNNING**. Needautomaticstandardfor791
then12Pverify/smokeagainst791 (fourruntimehashesunchanged). 12Pbaselineunchanged.
No releaseclaim for4ca; carryitsfixintoverified791release.

Refreshed429branch bymergingorigin/main; pushedcandidate
**02de7013770e5272245d6047d78fef654a39aabd**, exactQuality **37933788498PENDING**.
Old4e1d/37933168198superseded; explicitcancellationrequestedtofreecurrentcandidate.
Do notuseoldCI. PRbodyupdated. `prepare-production-health-gate.cjs` expects791
live; stillPREPAREDNOTRUN. Needcapturethenverify/smoke/guardwithnewIDsafterparent
verification. All original22healthchecks/type/lint evidence retained.

Returned12Sbranchandmergedrefreshed12R; localHEAD
**58117400762edd55fa305a56c2f481dd1704c10a**. Notpushed/noPR. Ownfive-ratecase
commitcd94unchanged;13actualpassed/types/lintcompletedexit0. Needeventual429merge
beforepushing12S. Noownedtestprocesses/fixturesleft. Dockerrestartedexistingvolumes
againafterpre-fixtureconnectionrefusal; noreset. Allusereditsstillpreserved.
Mainwatchattempt for37933118860finishedexit1duecancel; noactivewatchsessionfromit.

Thisgoalturnmadeprogress: independentlyverified12Mretry+publicreport,merged12P,
reproduced/fixedreleaseidentitygateand22controls/PR429,added5actualprofile-rate
controls,adaptedtootherusermainadvance. Wholegoalactive; notblocked/completed.

### Latest checkpoint — October 9, 12:59 UTC / 12P merged, 12R CI, 12S local controls

12M/#424 standard37914826551attempt2SUCCESS; refreshedindependentreadback
**10:17:35UTC** exactlive775/source/schema/advisors112unchangedPASS;smoke
200/200/307/401PASS. Publicrelease report andJOB02backuntested committed in12R.
OriginalpostpromotionIDmismatch retained; rootcauseNOTestablished. Watch8275
nowmissing; authoritativeGitHubcompleted meansfinished, don'trerun.

12P/#427candidate **c3772b1bbb701280d252b6f4c72fd87a8e313030** all5Quality
**37916144417SUCCESS**. Guardranfresh, merged **4ca608a1cf7a6859fe988c2382acdf4846dbd491**
at12:54:13UTC. 426mergedtransitively. ExactmainQuality **37933118860RUNNING**.
AftermainQuality andautomaticstandard: run`profile-request-bounds-release/verify.cjs SHA`
and`release-smoke.cjs SHA`. BaselinealreadycapturedDONOToverwrite. Need12Ppublic
release report+SOCIAL04backuntested onceindependentlyverified.

12Ractualworkflowrepro: runningexistingprotectedhealthshell againstlocalHTTP
acceptsmissingbuildIDandfailsold-then-currentafterfirstresponse (2failed/4pass).
ScriptsnowrequireexactSHAforstaged+promotedhealth;onlyvaliddifferentSHAretries,
max12requests/60stotal/5srequestdeadline,redirectsrefused,missing/invalid/HTTP/
malformed/unhealthycurrentfailimmediate. **22checksPASS** incl9actualshell/HTTP,
actual12staleexhaustion+nonrespondingserver,deterministicdeadline,4stagedNode,
6workflowguards;types/lintPASS. Private`production-health-gate-before/final*`.
Noapp/schema/credential changes. Reports include independentlyverified12Mrelease.
12Rbranch **codex/backend-release-health-gate-12r**,HEAD
**4e1d304e0de1d7c31e80418111dfc5618f991264**, PR**429** attached,
Quality**37933168198RUNNING**. Wait12Pverifiedbeforemerge. Generator
`prepare-production-health-gate.cjs` PREPARED NOTRUN; expects4calive then captures
unchangedschema/advisors +2release-sourcehashes. Needownverify/smoke/guard and
standardlogproofnewgateexecuted. OPS04failedfornewgatefindinguntilverification.
OtheruserPR428AndroidmenusOPEN; don'ttouch it, inspectmainifitadvances.

Current12Sbranch **codex/backend-profile-media-limits-12s**, localHEAD
**cd94d14677e16079fd5385264bb1027c609f775b**, basedon12R4e1d. NOTpushed/noPR.
Fiveadditionalrealcasesbringprofilemediasuite13:30signs/31st429noextrareservation
orsigning;30cleanup/31st429leavesrecreatedobject;otherownerlimitsindependent;
realRPC503signrate/cleanuprate/eligibilityfailclosed andsuccessretry. Actual
13PASS11.65s,types/lintPASS. Logs`profile-media-limits-active.log`,types/lint.
FirstlimitsrunDockerstoppedECONNREFUSEDbeforefixturewrites. RestartedDockerexisting
volumesnoreset,healthyStoragebeforepass. Don'tcountinitialconnectfailureasbug.
Report+SOCIAL04evidence+testcommitted. After429merged:mergeorigin/main then
push/open/attach12S. No runtimechangeornewfinding.

Ledger53:24pass24untested3failed2external (SOCIAL04pending12P,OPS04pending12R,
MEDIA07legacyretirement). Wholeauditactive. Userreceiptstilloriginalhash
bb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc. Onlyownedhandoff,
userreceipt,privateevidence,originaluseruntrackeddirty. No localfixtureleft.

### Latest execution state — October 9, 10:16 UTC

Actual checkout is now **codex/backend-audit-release-followup-12q**, at
c3772b1bbb701280d252b6f4c72fd87a8e313030 with no additional commit yet. This
branch is for release reports after verification; do not accidentally push its
reports onto the already-tested 427 candidate without refreshing CI/guard.

Standard37914826551 attempt2 is authoritatively in_progress, staging since
10:13:04UTC. Owned `gh run watch` execsession **8275** is still live; private
`upload-reclaim-managed-release/standard-retry-watch.log`. Poll same handle or
query GitHub; do not restart merely because observation yields. Candidate
37916144417 also authoritatively in_progress in all5jobs. Mainstill775.
Afterrelease success refresh managedverify+smoke (scripts exist), write12Mpublic
release report and JOB02→untested on12Q. Then427all5success+guard→main/release/
verify. Read10:13checkpoint for scriptnames/IDs and full test evidence.

Currentgoalturn made concrete progress: merged424, independentliveverification,
8actualmediacontrols and new12P request-limitrepro/fix/28actualcontrols,contract/
136mobile+30focused+types/lint,PR426/427,releasebaseline. No blocker threshold.

### Newest checkpoint — October 9, 10:13 UTC / 12P bounded-request fix in CI

424all5candidatepassed; mergeguard succeeded, **775f8b0e4a6f15c2d4e68323afd45ecfeac2965b**
merged09:49:40UTC. 423mergedtransitively; no separatemerge. ExactmainQuality
**37913764069all5PASS**. Standard **37914826551attempt1FAILED** protected
postpromotionhealthbuild-IDmismatch; sourcecause notestablished. Failurelog
retained in`upload-reclaim-managed-release/standard-failure.log`. Publiclive775;
strictmanagedverify schema/advisors112/runtimePASS andsmoke200/200/307/401.
Mainunchanged/mobileidlechecked, reranONLYfailedjob unchanged. Attempt2currently
staging; watchhandle see toolhistory. Must pass before mergingnextbatch.

12O branchpushed **5de9a24ab1158fba15cb6f60952d78da9cde8d84**, PR**426** attached,
Quality**37913803815all5PASS**. Includes eightactualprofilemediacontrols,app/schema
unchanged. **DO NOT MERGE426SEPARATELY**,427includesit.

12P currentHEAD **c3772b1bbb701280d252b6f4c72fd87a8e313030**, PR**427** attached,
Quality **37916144417RUNNING**. Newactualadapter/realAuthSQLrepro: fourprofile
adapters accept128KiBignoredpaddingand200withabsent/honest/understatedlength.
12beforefailures retained`profile-request-bounds-before.log`. Shared64KiB
streamedreader nowreturns413before domainwork, authstillfirst,validateoriginal
ratelimitstillfirst. Fourruntimefiles(profile-request-body.ts +profile/profile-
validate/profile-media adapters),nomigration. Sharedmobilecontract+3clientcases.
**28actualcontrols,30focused,136mobile,app/test/mobiletypes,scopedlintPASS**.
Exactfixturecleanup/countersPASS. Theseare actualadapters withnativeRequest/
streamsandrealAuthSQL; donotclaimdeployedNextHTTPsockettest. Unknownoversized
fields/whitespacecounted,exactlimitsucceed,UTF8bytecount,earlycancel/authbefore-
read tested. No newobligation. Ledger24pass24untested3failed2external (SOCIAL04
new12P,JOB02pending12Mrelease,MEDIA07retirement).

12PbaselineCAPTURED in`profile-request-bounds-release/`:unchangedschema/advisors,
4runtimehashes,nopendingmigrations. NEVERrerunprepare/overwritebaseline. Prepared
verify.cjs/release-smoke.cjs/merge-guard.cjs. Guardexpects427headc377/CI37916144417,
parent/live775/mainQ37913764069/standard37914826551success,independent12Mproof,
main/live/schema/advisors/mobileidle. Aftercandidate+parentreleaseallpass→guard→
exactmainQuality→standard→verify/smoke. NoSQLmutationneeded.

Needpublish12Mrelease reportafterretrysuccess,JOB02backuntested,then12Prelease
reportafteritsproductionverification,SOCIAL04backuntestedforbroadermatrix.
Userreceiptstillhashbb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc.
Onlyownhandoff/userreceipt/private/originaluseruntrackeddirty. Dockerstarted
thisturnwithoutreset; noownedtestfixtures/processesremain. Wholeauditactive.

### Newest checkpoint — October 9, 09:50 UTC / 12O eight actual controls committed

Local12O HEAD **8be8e698** (resolve full locally), based on424candidate7034838f.
Eight actual Storage/PostgREST/SQL cases pass in
`profile-media-publication-controls.log`; test types and scoped lint also pass
(`profile-media-*-publication.log`). Exact fixture cleanup and counter
reconciliation pass in every case. No runtime/schema change or new defect.
The extra profile save/edit case verifies immutable bytes/version survive
best-effort normalization and the later edit succeeds. Initial replay-after-
finalization expectation was corrected to denial (existing guard), not a fix.
Private failed diagnostics retained. Permanenttest/config/API-CIstep/report/
SOCIAL04evidence committed. Not pushed / no12OPR yet. After424merges, merge
origin/main into12O, push/open/attach nextPR. Its broader obligation stays open.

424candidate37912714396 currentlyallteststepspassed, APIstackteardownfinishing;
wait conclusion success beforemergeguard. Main/source/live baseline remainsc3.
User receipt hashunchanged; onlyownhandoff/userreceipt/private/originaluser
untracked dirty. No owned test process or fixtures remain.

### Newest checkpoint — October 9, 09:45 UTC / refreshed 12M candidate, profile-media controls

Main advanced through #425 to `c3db5de58ef2560f15982cb36a9a9c2f8df31cbb`.
Inspected all changed paths: Home/web/mobile UI changes, no migrations, audit
runtime or AGENTS changes. Main Quality37907709099 and standard37909099459
passed. Independent 12K verifier refreshed successfully against c3 (schema,
permissions, runtime, advisors112), smoke200/200/307/401. Previous b950 JSON
proof is preserved in `upload-reclaim-leases-release/verified-b950-snapshot/`.

Merged main and local 12N report commit6ae05497 into PR424 branch, pushed
**7034838f164de720940bbe19309dd96ddf193311**. Exact candidate Quality
**37912714396 RUNNING**. Guard updated to this candidate/current c3 parent and
its exact Quality/standard IDs. All five must succeed before running guard.
No other guard bypass; parent runtime remains unchanged. PR body refreshed.
After merge wait exact-main Quality + standard, then managed verify/smoke.

Separate local branch **codex/backend-profile-media-controls-12o** has new
uncommitted `profile-media-postgrest.test.ts` and dedicated config. Seven real
Storage/SQL cases: avatar, cover, metadata, ownership, remove failure, lost ACK,
duplicate cleanup. Initial test run never connected (Docker daemon/database
were stopped, no fixture writes). Started Docker; existing volumes returned
without reset. Rerun and types/lint in progress; inspect private
`profile-media-controls-active.log`, `profile-media-types.log`,
`profile-media-lint.log`. Do not claim a product defect from the initial
connection-refused log. No application/schema change yet.

Whole audit remains active. Ledger24passed/25untested/2failed/2external.
User receipt diff hash unchanged bb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc.

### Newest checkpoint — October 9, 04:24 UTC / 12K release retry passes, 12M CI

PR422merged **b95045d844079717745be85058a6cfc314667d32** at04:05:19UTC;
421markedmergedtransitively. ExactmainQuality **37882251025** all5pass.
Standard **37882874131** attempt1 promotedcorrectbuild thenfailedprotectedhealth
build-IDcheck. Publiclivealreadyb950; strictreadback04:19:43 source/schema/advisors
allpass, smoke200/200/307/401 and rollback04:19:56 all4invariantspass/sixcleanup0.
Localopscredentialwas401so don'tclaimindependentprotectedhealthfromit. After
freshmain/public/strictverification, reranONLYfailedjob unchanged; **attempt2
nowSUCCESS includingprotectedhealth**. Freshstrictverification session89936 was
earliercomplete; a newrefresh is currentlyrunning (inspectsession/toolhistory).
Needpublic12Krelease reportcommit and MEDIA09backtountested. Migration12Kapplied
ledger **20261009041440**; NEVEReditappliedfile.

Actual timedcapacityprobe session60411 **completedPASS exit0**,961.92s. Real
60scapabilityexpiry03:49:44, firstabsenceobservation03:49:45, earlypasskeptcharge,
real15mingate04:04:45 thenrelease04:04:46 counter0, duplicateempty, exactcleanup0,
reconciledcounters. Public12Kreporton12L/12Mincludesthis. 422mergeguardrequired
thisevidenceandall5candidatepass beforemerging.

12L private signedread/range testcommitted/pushed **f81718abc836d9594b82d530a864a011729f6ee2**,
PR **423** attached. Quality **37882285385all5pass**. **Don'tseparatelymerge423**:
12M424includesallitscommits. Realowner/crossowner/anon/privatepublicendpoint,
token/pathintegrity,actualexpiry/deletion,valid206exactrangeandfailedunsigned/
expired/deletedranges,otherownerpreserved; integration/types/lintPASS.

Currentbranch **codex/backend-upload-reclaim-job-reporting-12m**, HEAD
**1d77d6583ed8cd568a185bec4b8130f413302c39**, PR **424** attached. Exactcandidate
Quality **37883585276RUNNING**. Newactualreproduction: rejectedlegacyeligibility
RPCstoredsuccessfulno-work; rejectedrepairselectionwithanoldconsumedintentstored
succeeded/emptyrepair. Logs/result`upload-reclaim-managed-before*` andfirstfull
controls retainfailures. Bothcatchblocksnowlog+throwtoexistingmanagedwrapper.
NoDDL. 7newactualmanagedcases empty/eligibilityerror/intenterror/repairerror/
claimerror/locked/normalwithdurablerowassertions,retries,duplicates,exactcleanup0.
All **28actualreclaimcases** PASS final `upload-reclaim-managed-all-held-worker.log`
(exit0,27s);27focused,app/testtypes,scopedlintPASS. Firstfullrunhadrealrepair-error
findingand501object30stimeoutunderhostactivity; secondfullrunexposedworkerfixture
normalexitbeforeSIGKILL(pendingPromisealonewon'tkeepNodealive). Ownedworkerpause
nowkeepsintervalaliveuntilparentSIGKILL; originalsignalassertionunchanged. Preserve
failedlogs; finalfullsuitepassed. Do notkillotheruserprocesses/devservers.

12Mprivatebaseline **captured** againstb950 in`upload-reclaim-managed-release/`:
unchangedschema/advisors112,2runtimehashes(repair/reclaim),nopendingmigration.
DoNOTrerungenerator/overwritebaseline. verify/smokeandmergeguardprepared. Guard
expects424head1d77/run37883585276,parentb950/mainQ37882251025/standard37882874131
successful,currentmain/live/schema/advisors/mobileidle,and12Kindependentcomparison.
Afterallcandidatepass→guard→exactmainQuality→automaticstandard→12Mverify/smoke.
No12MproductionSQLmutationneeded. 423shouldmerge transitively.

Local12Mledgercurrently24passed/24untested/3failed/2external untilrecord12Kverified
(MEDIA09returnsuntested) then24/25/2/2 (JOB02new12M+MEDIA07). Wholeauditactive.
Receiptuserhashunchanged; onlyownhandoff/userreceipt/private+originaluntrackeddirty.

### Newest checkpoint — October 9, 03:57 UTC / real-time capacity probe running

Active checkout is now **codex/backend-private-signed-read-controls-12l**, HEAD
**ba003425** (resolve full locally). It contains final12K4b96 plus a separate
local test-only signed-read batch; **not pushed / no12LPR yet**. Wait422merge,
mergeorigin/main into12L, then push/open/attach nextPR. Do not put12L onto422.

PR422 finalcandidate **4b96b6d84d8ee977dcf28b352773ca45ef919c7e**, Quality
**37880754176**: migration/API/mobile/E2E allpass, webBUILD running lastcheck.
Parent3d/standard37878281215 independentlyverified as below. **Mergeguard now
also requires the real elapsed-time capacity probe to complete and clean up.**
Do not remove that gate or claimcapacityrelease before its result exists.

Owned exec session **60411** is running the private actual-life-cycle test:
`upload-reclaim-capacity-lifecycle.test.ts` with private config/log and result
prefix of same name. It created one exact local fixture recorded privately in
`...-fixture.json`. API55321/DB55322 only. Storageobjectdeleted; reservation is
charged at262144000. Actualcapabilityexpired03:49:44UTC; firstretentionpass then
claimedreclaiming and an earlysecondpass deferredwithoutrelease. Its real
quiescence ends **04:04:45UTC** (~09:34:45 IST); test automatically resumes just
after, assertsabsentrelease1/counter0/duplicateempty and exactcleanup0/counter
reconciliation. It uses30secondnonblockingwaitchunks, nofakeclock. HTTPread
selectionislimitedtoitsowner toavoidprocessingotherlocalauditfixtures. No
provider/production calls. DO NOT reset55322 or restart/kill this owned process
while it is alive. Poll `write_stdin` session60411; output is buffered but
`...-progress.json` records durable phases. If handlemissing inspectprocess/log
and exactfixture before decidingcleanup; never rerunblindly. Testtimeout20min.
`upload-reclaim-leases-release/merge-guard.cjs` checks final result +cleanupzero.

Afterall5candidateANDcapacitypass: run422guard, waitnewmainQuality +automatic
standard, run12Kverify/smoke/SQLrollback. RecordreleaseandreturnMEDIA09untested
forbroaderremainingmatrix. 421commitsincluded; don'tseparatelymerge421.

12L actual private signed-file scenario passes nine controls: owner200/exact
bytes; cross-owner andanonymoussigningdeny; unsignedprivateendpointdeny;
token/pathtamperingdeny; realtwo-secondURLexpiresafterfourseconds; deletion
invalidatesstill-validURL; otherownerobjectsurvives. RealAuthpasswordsignin,
Storage,SQLcleanup users/objects0. Permanenttest
`src/__tests__/private-signed-read-postgrest.test.ts`, dedicatedVitestconfig and
API-CIstep, publicreport andMEDIA08link committedlocallyba003425. One sequential
scenario, ninecontrols; donotcallitninetestcases. Permanentintegration/testtypes/
lintPASS exit0. Noapp/schema change. Private baseline/permanent logs andresult
`private-signed-read-*`; PRbodyready `private-signed-read-pr-body.md`. No hosted
CDN/video/range/providerimport/nativeentitlement claim. No newdefectfound.

Userreceiptstilloriginalhashbb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc.
Onlyownedhandoff/userreceipt/privateandoriginaluseruntrackeddirty.

### Newest checkpoint — October 9, 03:47 UTC / 12I verified

12I is released and independently verified as **3d709e529add076ec17d0863dba968f70086119c**.
Main Quality37877301611 and automatic standard37878281215 succeeded. Strict
readback03:44:42 confirms five clean-replay schema additions, other signatures
and permissions unchanged, 112 advisors unchanged, exact runtime/migration
sources. Production ledger applied version **20261009031400**; never edit12I.
Smoke200/200/307/401 and unsigned reclaim401no-store pass. Four bounded SQL
rollback checks pass03:44:50, independent fixture users/intents0. Public report
`backend-section-12-upload-reclaim-progress-release-2026-10-09.md` committed on12K.
JOB-02 returns untested; ledger **24passed/25untested/2failed/2external**.

12K final candidate now **4b96b6d84d8ee977dcf28b352773ca45ef919c7e**, PR422,
Quality **37880754176** RUNNING. Previous58674408/37878210304 all5pass is
superseded. Follow-up actual regression found inherited one-day reclaim_after
survived deleted-state ownership; four cases failed before, all21 pass after
newRPC clears scheduling deferral atomically. Original expiry and quiescence
remain. Local migration12K updated (still UNAPPLIEDprod); cleanreplay plus
**2360SQL/111files**,28focused,testtypes/scopedlint allpass aftercorrection.
Logs `upload-reclaim-leases-deferral-before.log`, `...-deferral-after.log`,
`...-replay-final.log`, `...-pgtap-final.log` preserve the sequence.

**12K baseline capture IS COMPLETE** against verified3d: two expected new
function/service-role-grant signatures from finalcleanreplay, unchangedschema,
112advisors, unique pending12Kmigration and sourcehashes, inventory. Never rerun
`prepare-upload-reclaim-leases.cjs` or overwritebaseline. 12Kmergeguard updated
for4b96/run37880754176, main3d/Quality37877301611/standard37878281215. Requires
freshschema/advisors/live/main/mobile-idle checks. Afterall5candidatepass,
run `upload-reclaim-leases-release/merge-guard.cjs` then waitexactmainCI and
standard release, run12Kverify/smoke/rollback. 421includedin422; don't separately
merge421. New12Kpublicrelease report and MEDIA09status remainpending.

### Newest checkpoint — October 9, 12I merged / 12K candidate

PR #419 passed all five candidate gates (37876225878), then its guarded merge
succeeded as `3d709e529add076ec17d0863dba968f70086119c` at 03:00:54 UTC.
Exact-main Quality **37877301611** is running (four jobs passed, web building at
last check). Wait for all five and the automatic standard production release;
then use `upload-reclaim-progress-release/verify.cjs SHA`, `release-smoke.cjs SHA`
and `rollback-probe.cjs SHA`. Do not overwrite its pre-DDL baselines. Production
12I verification and its public release report are still pending.

12J is pushed as `8723c10d85357653735dfff1aa7b129344e0cedf`, PR **#421** attached.
Its three real worker-death cases pass (14 total before 12K). **Do not separately
merge #421**: the complete #422 batch includes those commits and its verified
12H release report. Merging #422 should include/close #421 transitively.

A separate 12K bug is now actually reproduced: the real finalization service
acquires a second generation read lease, but staged cleanup deletes the object
and clears its old consumed intent while its reservation is still `consuming`.
A real download then fails. Private `upload-reclaim-active-lease-repro.log` and
`...-before.json` preserve the valid failure. Initial teardown column typo is
separate `...-teardown-error.log`; corrected cleanup is all zero and upload
admission counters reconcile. No production objects were used.

12K candidate **586744089344d25baf82771a8195026a1313ffc1**, branch
`codex/backend-upload-reclaim-active-leases-12k`, PR **#422** attached. Quality
**37878210304** is the current gate. Initial e179882c / 37877957352 is superseded;
its cancellation was requested to free the current candidate. Never use the old
run to merge. New migration **20261009030218_fence_media_upload_reclaim_consumption_leases.sql**
is local-only (DB55322 and clean replay55332); do not apply manually to production.

The new service-only bounded RPC locks the owner/path and matching reservation,
withholds consuming/uncertain/preserve/unfinalized rows, and changes an eligible
finalized/consumed reservation to deleted before external Storage deletion. This
closes admission to later readers atomically. It does not release capacity or
clear the intent; rejected/lost-ack deletes and post-claim process death retry.
Legacy unreserved readers remain outside this v2 fence. Existing deleted-state
accounting holds the original reserved-byte maximum until the reservation worker
proves absence; the new tests explicitly check this conservative charge.

Local evidence: **21 actual API/Storage/SQL cases**, including seven new lease
cases and an actual SIGKILL after the claim; **28 focused tests**; app/test types
and scoped lint; **clean replay + 2,360 pgTAP assertions in 111 files**, all pass.
An added counter assertion was rechecked in all seven lease cases. Initial app
typecheck hit a stale generated `.next` declaration from the #420 removed route;
`next typegen` refreshed it and final app/test types pass. Logs are private
`upload-reclaim-leases-*`. Public 12K report and ledger are committed. Ledger is
now **24 passed / 24 untested / 3 failed / 2 external** (53): MEDIA-09 reopened
for 12K, JOB-02 still pending 12I release, MEDIA-07 legacy retirement remains.

12K release preparation exists but **baseline capture has NOT run**:
`prepare-upload-reclaim-leases.cjs` requires live 3d709e52 and captures exactly
one pending 12K migration, two clean-replay function/grant signatures, unchanged
schema/advisors and inventory. Run ONLY AFTER independent 12I verification.
`upload-reclaim-leases-release/` already has verify/smoke and rollback scripts.
The bounded rollback SQL passes four local invariants and six zero cleanup
counts. Initial local probe incorrectly tried a private charge helper as service
role, then assumed the finalized rather than reserved charge; both diagnostics
are retained. Final probe checks the actual service-readable reserved counter.
It inserts only synthetic SQL metadata inside a transaction; no Storage/provider
API call. Production wrapper refuses to run before strict deployed verification.
Need prepare new exact-main/candidate/mobile-idle merge guard for #422 after
12I standard release is independently verified; never bypass that gate.

User receipt diff remains `bb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc`.
Only owned handoff, user receipt and original user/private untracked files remain
dirty. No subagents, provider charges, real balance repair or production load.

### Newest checkpoint — 2026-10-09 / main420 included

Mainadvanced51c4eefab1bf4ec1812d29f4313a14ce10ed56c6 (#420web/mobilecheckup),
Quality37819267292 andstandard37820897239bothsuccess. AGENTSdiffread(rewritepath
clarification). No migrations or changes to12G/12I runtimefiles. Independent51
verify+smoke PASS inupload-reclaim-controls-release; 12HoriginalcfcQuality37793677744
andstandard37795497135 alsosuccess. Public12Hreleaseevidenceaddedlocallyon12J.

419 nowcandidate513fe9a74a51965aea02c78d71ee193ab96a5944 aftermergingnewmain,
Quality37876225878 queued/running. Oldb962Quality37794086091 all5pass is superseded.
Updated419guard expects51parent/live,newcandidate/run, parentQuality37819267292
andstandard37820897239, independentlyverifiedparent. Allbaseline12Ipre-DDLintact.
Waitall5candidate→guardmerge→mainCI→automaticstandard→12Iverify/smoke/rollback.

12Jbranchmergednew419headwithoutconflict, local315cd2d89bf260a935ac934dfc8f5a93d9432b9b.
Its3actualSIGKILLcases(and14total), types/lintpreviouslypass; commitca3ec428 preserved.
No12JPRyet; wait419merge beforeopening12JevidencePR. Userreceiptunchanged.

### Newest local12J while gatesrun

Activebranchcodex/backend-upload-reclaim-worker-recovery-12j basedonb96212I.
ThreeactualownedNodeSIGKILLcasespass afterscanmarker/StorageDELETE/clearingPATCH.
EachreadsdurableSQL/Storagebeforekill, verifiesSIGKILLexit, startsfreshreplacement
andduplicate, keepsoldneverconsumedcontroluntouched(flagabsent), verifieszero
ownedusers/intents/objectsaftercleanup. 14totalactualreclaimcasesPASS, testtypes
andlintPASS. Workerhelper+test+config+report+jobmatrixcommittedlocally; notpushed
orPRyet. No runtime/schema changebeyondinherited12I. Outerjobfencing/reference
racesnotcertified. Privateupload-reclaim-worker-death.log. Wait419merge thenmerge
itsmain into12JbeforeopeningnextPR. Donotstageuserreceipt orprivateevidence.

Parent418mainQuality37793677744 stillrunning APIreferralintake/webtests;419Quality
37794086091 stillrunning. Specificrunsarelive; donotrestart. Parentstandard,
independentparentverify,and419guard/merge/release remainasrecordedbelow.

### Current PR419 / final local checkpoint

12I committed/pushedb962d6520f1cf433a0d3a33a2707bfd0a93fafb4. PR419
https://github.com/112kratoss/ugc-copy/pull/419 attached, Quality37794086091 running.
Parent418 main cfc0b1c24a871a1c6a62314e24be10ac3b16a548 Quality37793677744 running.
No user changes staged. Existing receipt diff stillbb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc.

11actualfinal/36focusedfinal/app+testtypes/lint/cleanreplay2350SQL PASS exit0.
Four SQLrollbackinvariants also locallyPASS withzero cleanup; productionprobe
requires strictcomparisonfirst. Private12Ireleasehasverify.cjs,smoke,rollback
SQL+wrapper+cleanup,5expectednewsignatures,112advisorbaseline,sourcehashes,
onependingmigrationplanandinventory242/160/0oldconsumed. Do notrerunbaselineprep.

Next: waitparent418mainQuality thenautomaticstandard; verifycfc0b1c2using copied
12Gverifier+smoke inupload-reclaim-controls-release (runtime/schema unchanged).
Guard for419 inupload-reclaim-progress-release expects exactb962/cfc/mainQuality/
candidateQuality, but parentstandard deliberatelyPENDING_PARENT_STANDARD: resolve
successfulstandardrunandreplaceplaceholderONLYaftermatchingSHA; verifyparent
comparison. Thenall5candidatepass→guardedmerge→exactmainQuality→automaticstandard
→strict12Iverify/smoke/rollback. No manualdeploy or duplicateworkflowdispatch.
12Goriginal676release evidencepreserved. JOB02failedfor12I; fullauditactive.

### Newest checkpoint — verified12G / local12I / merged12H

12G is LIVE and independently verified as6766777860d3099478948b57ef7f14b4d63295f5.
MainQuality37790197606 all5pass; standard37791925353success. 14:27:25UTC strict
readback exact2runtimehashes/schema/advisors112unchanged and smoke200/200/307/401.
Public12Greleasereportaddedon12Ibranch. JOB02staysfailed fornew12Iprogressfinding.

PR418 candidate69c6cd87 Quality37792050694 all5pass; guardedmerge succeeded
cfc0b1c24a871a1c6a62314e24be10ac3b16a548 at14:35:09UTC. MainQuality37793677744
running. Nine realuploadcleanupcontrols; noapp/schema changes. Needmainall5,
standardrelease then copied12Gverifier/smoke toconfirmunchangedruntime/schema.

Activebranchcodex/backend-upload-reclaim-progress-12i, basedon418merge cfc0b1c2.
Real501objectfixture: two500rowpasses selectsame500protecteduploads, leaving
laterreclaimable501stuntouched. Beforelog/repro/result/cleanupprivate. Initial
SQLparameterfixtureerrorseparatelyretained; nottheapplicationrepro. Allcleanup0.
Candidateadds reclaim_checked_at andgeneratedcoalesce(check,created)priority plus
partialindex, marksboundedselectedbatchbeforeexternalwork, orderspriority/id.
Age/protection/rollout unchanged. Initial500UUIDmarkerPATCH hit URI-too-long;
markerandclearingnowchunk100IDs. Actualcasepasses lateritemsecondpass, all500
protectedpreserved, thenall500clearafterprotectionremoved, finalempty/objects0.
Newmarkerwritefailurecasefailclosed. 11actualcontrols,36focused,app/testtypes,
lint,cleanreplayand2350SQLassertions110filesallPASS. MigrationCLIgenerated
20261008142924_rotate_checked_upload_reclaim_candidates.sql UNAPPLIEDproduction.
Local55322appliedandclean55332replayed. Needcommit/push/PRandallreleasegates.

Privateupload-reclaim-progress-release baseline captured againstverified676:
5exactnewsignatures(cleanreplay),unchangedschema,112advisors,completeledgerplan
onlynewmigrationpending/nooutoforder. Candidatehashesrecorded. Inventory242intents,
160uncleared,0oldconsumed: nocurrenteligibleaffectedbacklog/historicalrepair.
Do NOT overwritethesebaselinesafterdeployment. Receiptuserdiffunchanged.

### Latest — 12G release staging, expanded12Hcandidate

Exact-main Quality37790197606 all5success. Automatic standard37791925353 currently
staging6766777860d3099478948b57ef7f14b4d63295f5. Once succeeds, run12G
`media-rendition-budget-release/verify.cjs SHA` then`release-smoke.cjs SHA` and
recordverifiedrelease. No12Gmigration or productionmutationneeded.

PR418 https://github.com/112kratoss/ugc-copy/pull/418 attached. Finalcandidate
69c6cd8728f826b8e790af99f322f44775425077, Quality37792050694 running.
It expands6to9actualuploadcleanupcases: reallegacygenerationstoredpath,
signedURLandfailedprotectionRPC inadditiontofirst6. All9localPASS including
zeroAuth/intent/Storage/generationcleanup, testtypes+lintPASS. Oldcandidate
9a9cc948 Quality37790871297 superseded; donotmergebasedonoldrun. No runtime/DDL.
Activebranchcodex/backend-upload-reclaim-controls-12h. Candidatecommitted/pushed.

### Newest checkpoint — PR413 merged / 12H local controls

PR413 merged as6766777860d3099478948b57ef7f14b4d63295f5 at14:09:42UTC.
All5candidate37787974905 passed; parentb4 standard37789509511 succeeded and
copied12Fverifier+smoke passed. Guard then checked main/live/schema/advisors/mobile
idle and merged. Exact-main Quality37790197606 running; automaticstandard and
independent12Gverify/smoke remain pending. Do NOT call12Greleasedyet.

Active local branch codex/backend-upload-reclaim-controls-12h starts at413merge.
Six actual local upload-reclaim controls pass: normal/removeerror/lostack/markerror/
protected/unverifiable. Exact cleanupzero; no runtime/schema change. Tests types
andlintpass. Newtest+config+CIstep andpublicreport beingcommitted; production
protection-set construction/races, signedexpiry/backlog/death remainuntested.
Original6caseinstrumentedfixture andpercaseJSON remainprivate. This is scoped
regressioncoverage, not wholeMEDIA/JOBclosure. Receiptuserdiffunchanged.

### Newest release gate — 2026-10-08

PR413 candidate fa1be24a Quality37787974905 ALL FIVE PASS. Merge guard correctly
stopped before merge because another actor reran main Quality37784965464: attempt2
now passes all5. Parent b4fad8be standard37789509511 is in progress, with companion
37789712069 pending (do not dispatch duplicate workflows). Wait for parent release,
then independently verify b4fad8be using copied `media-rendition-budget-parent-release/`
verify.cjs + smoke. Original12F43631e8a evidence is preserved. Updated12G merge guard
expects b4 main/live, parent standard37789509511 and all5main/candidatepass; run
only after parent independent comparison succeeds. PR413 has NOT merged yet.

### Current checkpoint — 2026-10-08 13:56 UTC

12F is independently verified on live `43631e8aa2112cdac259af48cbfa30ce75505179`.
Original #412 main Quality 37722828062 and standard 37723828380 passed.
Live standard 37772138814 also passed. Strict readback at 13:49:53 UTC confirms
all expected schema/function/ACL/source checks, migration ledger 20261008034053,
and 112 advisors (only the expected private-table INFO added). Smoke passes;
production rollback at 13:50:22 UTC passes all checks and independent cleanup is
zero. Public release report is committed on the 12G branch. PAY-04 is untested
again; JOB-02 remains failed for 12G. Ledger: 24 passed/25 untested/2 failed/2 external.

PR #413 is open and attached. Current candidate
`fa1be24a0736635100d0dca9c47f9e5fa63c721a`, Quality 37787974905 running all five.
Its old Quality 37722931809 failed the pre-existing account-switch credit test;
current main `b4fad8be34e81b991babfc5443617e218f07784b` Quality 37784965464 failed
the identical assertion. Main includes #414–417, merged locally without conflict;
new AGENTS changes read. No schema changes in those PRs. Do not rerun broken main
just hoping it passes. Candidate now fixes the race: synchronous credit-request
identity invalidation and identity check inside the React updater. A deterministic
extra test fails before, passes after; 25 account/shell tests, app/test types and
lint pass. No stored balances changed. Existing assertions retained. Current main
is not deployed; live remains 43631e8a. A merge guard must distinguish current main
from last passing live parent and document the sole known main failure fixed by
this candidate. Exact candidate all-five success is mandatory.

12G release verification is prepared in private `media-rendition-budget-release/`:
112-advisor and schema baselines after verified12F, two runtime hashes (media
worker/account component), strict verify.cjs + release-smoke.cjs. No migration.
It still needs candidate CI, guarded merge with fresh main/mobile-store check,
exact-main Quality, automatic standard release and independent live verification.
No original 12F baseline/evidence was overwritten.

Next media lease investigation is private `media-publish-lease.test.ts`/config.
It checks publish-time repair against an already held sweep lease. First execution
failed because Docker was stopped (ECONNREFUSED55322), NOT an application repro.
Docker launch requested. Existing isolated stack workdir is
`.audit-evidence/backend-storage/local` (API55321/DB55322); start CLI2.75.0 without
reset and keep output private (keys). Do not claim a new defect until actual test.
Receipt user diff hash is unchanged: bb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc.

### Additional investigation scope correction

Docker restarted successfully; original local stacks recovered without reset.
The private media-publish-lease probe does reproduce direct-helper lease overwrite
(actual local SQL/Storage, cleanup zero), but production reachability review shows
`repairMediaForPost` has NO runtime callers. All three publish adapters explicitly
ignore the deprecated seam; route tests assert no publish repair scheduling.
Do not label this a reachable production defect or implement speculative lease
changes. Evidence/scope note: `media-publish-lease-scope.md`. A temporary local12H
branch was created at fa1be24a with no edits/commits and removed after scope review; active branch is back on12G. The 27 route adapter controls passed.

### Superseded historical checkpoints

NEWEST: #412 mergedf7067d5ef9fda9be8cbc5d5ee26644bd5f00a49b at03:27:43UTC.
Finalcandidate6a991e50 Quality37722003054 all5pass. Guardverifiedparent53d,
standard37722339684, newparentindependentreadback andmobile-storeidle. GitHub
marked411merged transitively becauseincluded in412 (closeattemptsaid already
merged; no separatemainpush). Exact-mainQuality37722828062 queued/running.
Waitall5→standardautomatic→12Fverify.cjs/smoke/rollback exactliveSHA. No manual
productiondeploy. Do NOT call12Freleasedyet. Baselines intact; expected2progress
cases; productionexpected111+onlynewprivate-tableINFO. Local12Gbranch nowmerged
origin/main f7067d5e withoutconflict. 12Ginventoryread-only:9video rowsallready,
attempt1,noexpiredleases; nohistoricalrepair indicated. Reportupdatedlocally.


LATEST: parent53d9314b standard37722339684 succeeded; fresh copied12Cverifier
and smoke bothpass53d. Originalcc159f12Crelease evidencepreserved.12Fmergeguard
nowexpects37722339684/parentQuality37721330661; allparentgatesready. Final412
candidate6a991e50 Quality37722003054 lastseen APIonboarding /webtesttypes with
other3success. Waitall5thenuseguard (checks freshmain/live/mobileidle/schema).

12G newlocalcommitbdf4322e oncodex/backend-media-rendition-budget-12g, branched
fromfinal12F. Actual PostgREST/Storage/SQL repro: batch2/timeBudgetMs0 downloads
firstrowonly but leavessecond processing/count1. Initial fixtureSQLtypeerror was
fixed; validbefore logmedia-rendition-budget-repro.log+before.json; cleanup0.
Fix onlynormalbudgetexit: release unstarted leasedtail guardedbyid,oldowner,
processingstatus,exactreservedcount; decrementunusedattempt,clearlastlease.
Killedworkerkeepsreservation. 6actualcasespass normalrepeatedbudgetprogress,
newowner/changedcount/terminalfencing, rejection+lostack.43focusedpass,app/test
types+lintpass. CIstepadded. No migration/provider/encoder call. Localcommitnot
pushed/PRyet; wait412merge thenmerge itsmain into12G before openingnextPR.
Runtimefile src/lib/media-preview-repair.ts only. Report committed12G.
JOB-02muststayfailed for12G after12Fverified; no newobligationadded.


LATEST12F: candidate6a991e50fdac0df3586c91d00c280e2865d4e567,
Quality37722003054 pending/running. Olda7e2candidate superseded. Cadence review
reproduced healthy-starvation again when all failed retry rows were alreadydue
at next hourlyjob. Correction orders by coalesce(retry.updated_at,txn.updated_at)
to rotate failures behind olderwaiting work. Both immediate/overdue101purchase
regressions pass; cleanreplay/full2340SQL pass; types/lint pass. Local55322updated,
clean55332replayed; onlyexpected candidate signatures/defs/hashrefreshed,
production baselinespreserved. PR412bodyrewritten includes/supersedes411; merge
412afterallgates thenclose411 (do not separatelymerge411). New12Fmergeguard
expects53dparent/currentcandidate/currentCI and deliberatelyplaceholderparent
standardrelease. Resolve parentrun, verify53d with copied12Cverifier in
referral-settlement-progress-parent-release (preservesoriginalcc159fevidence),
thenfillplaceholderandmerge. Nootherproductionchangesbeyondstandardworkflow.

12C PR #407 is deployed and independently verified. Live tested SHA
cc159f7e7fdea346476543d40756cbe442092261, exact-main Quality37719493430 attempt2
all5success, standard37720962542success. Independent verification03:08:34UTC
2026-10-08: ten SQL definitions/ACLs, auth trigger, expected schema changes,
remaining schema unchanged,111advisors unchanged, exact live/source, smoke200/
307/401. Both bounded production rollback probes pass; independent cleanup all0.
Migration20261007174934 maps productionledger20261008030458. Release report
backend-section-12-referral-deletion-release-2026-10-08.md committed in #412.
Earlier merged-main attempt failed one pre-existing admin collector upstream
response;48 local controls passed, its rerun superseded/cancelled. Failed logs
retained. Original expanded candidate SQL trigger-order failure also retained.

Main subsequently advanced to53d9314b65f30829eeaf62cba60a2cd4108120c1 (#410,
PixVerse mobile/catalog/consent change). It has no migrations/AGENTS changes.
Quality37721330661 running. Merge guard for411 correctly rejected the old parent;
wait for new parentQuality+automaticstandard+independent12Cverifier/smoke on53d,
then update guard IDs/SHAs before merge. Preserve the originalcc159f evidence
when rechecking newer parent (copy verifier directory rather than overwrite).

12E PR #411 candidate5659c8ad288f3ef31c91c80d0147ccee1c81f336 includes newmain,
Quality37721555582 running. Old b3d20307 run37720268560 passed all5.44 actual local
Auth/PostgREST/SQL route/admission checks pass, including real guest/revoked
sessions, actual rate thresholds, competing claims, owner scoping and cookie
claim. App/test boundary is actual but not full NextHTTP/browser/native. No
runtime/schema changes. Full test types and lint pass. 12D historical review
committed here. Merge guard private referral-intake-release/merge-guard.cjs
currently deliberately STALE cc159fparent/b3dhead: update to finalcurrent IDs.

12F PR #412 candidatea7e2a38c (resolvefullSHA/run), branch
codex/backend-referral-settlement-progress-12f includes411/newmain. Reproduction:
actual local service retries100 older failing transactions twice and never
settles the later healthy purchase. Fault is one fixtureinviter atintegerceiling;
no claim this happened to production users. Before result/log/cleanup retained.
Fix: CLI-created20261008030002_defer_failed_referral_purchase_settlements.sql,
private retry table, guarded deferral with1minute→1hourbackoff, selector excludes
notdue rows, eventinsert atomicallyclears retry. Service defers onlysettlement
errors; notification failures keep12Bqueue. No realbalances changed.
Tests: actual101purchase regression passes healthysecondpass+100recovery,
increasing/cappedbackoff, counter saturation, foregroundcleanup and staleack;
9focused,18notification,16deletion pass; cleanreplay2340assertions109files PASS;
app/testtypes andscopedlint PASS. Candidate implementation/docs committed/pushed.
Release prep: private referral-settlement-progress-release/ has production
baseline after12C, cleanreplay3definitions/ACLs/21signatures, unchangedschema,
111advisorbaseline; only12Fmigrationpending/nooutoforder. Inventoryallreferral0.
Strict verify.cjs expects exactliveSHA/runtime/migration, expected one additional
private-table INFO advisor; smoke/prodrollback wrappers prepared. Bounded SQL
rollback controls pass locally withzero cleanup. Do NOT overwrite predeployment
baselines after12Fapplied. Need candidateCI, parentgates, productionrelease, strict
verify/smoke/rollback.412currentlyincludes411 until411merges; no needduplicate
its work. PAY-04/JOB-02 failed for12F; AUTH-03 untested after12Cverified.

12D historical admin-credit review resolved read-only: promotional-only25000
AppReviewtopup alreadycorrected by later sameaccount +25000total/0promo entry.
No grantdue; anothercompensation wouldduplicate. Publicreportcommitted411,
privatehistorical-admin-credit-review-private.json/followup.json keptprivate.

Current ledger53unequalobligations:24passed24untested3failed2external. Remaining
failures PAY-04/JOB-02(12F), MEDIA-07(legacyretirement). Fullgoalnotcomplete.
Userreceipteditsha256 remainsbb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc.
Do not stage it or originalsection1untracked evidence; .audit-evidenceprivate.

### Historical candidate checkpoints (superseded by the state above)

#407 expanded8871bd69 CI37679833609 passes web/mobile/browser/API but fails
pgTAP guest_account_link test9: new receipt identity trigger changes established
error text while still rejecting reassignment. Local expanded pgTAP also failed;
a later preparation command had masked its exit status. Preserve failed logs and
correct claims: run standalone pgTAP. Candidate now names the mobile detachment
trigger zz_..., after the existing immutable-receipt guard, preserving its error
contract.16 actualcases and clean replay pass; standalone final SQL running.
Main additionally advanced through#406/#408 to b4ceb0881a5f47705e452b13aa3694e502c7828b,
Quality37716917060 running. Both independent model changes merged locally without
conflicts; no new migrations/AGENTS. Guard still has stale d4b parent and8871head:
MUST update after final commit/CI and independently verify released b4ceb parent.
Do not use prior passing checks to merge the corrected candidate.

#407 final expanded candidate8871bd699750ba6fe56f8f68d82c8019bc4b27b2,
Quality37679833609. The old0013c34c run37678774653 is superseded. Strict private
merge guard and candidate migration digest now expect8871bd69/newrun. All16
actual cases pass, including authenticated App/Play webhook refund/restore and
cross-owner purchase restore denial. Final clean replay/2328 SQL assertions,
18 payment-database regressions and types/lint pass. The active full audit goal
remains incomplete; wait for final candidate all5 then normal guarded release.

12C candidate expanded before release: actual App/Play Store refund after buyer
deletion reproduced identity_mismatch, leaving the inviter credited. The same
unapplied migration now retains mobile receipt identity and matches detached
original owners only for credit adjustments; cross-owner adjustment and purchase
restore stay rejected. Actual authenticated webhook handler cases use local
PostgREST/SQL.16 lifecycle cases,18 existing payment SQL cases and final2328 SQL
assertions/clean replay pass. Release expected signatures now include10 functions
and the mobile receipt identity column/trigger. Old0013c34c CI is superseded once
the expanded head is pushed; do not merge it merely because it passes.

12C PR #407 is attached: candidate0013c34c59ef137c93dc4dfb70dfc92327baeb21,
Quality37678774653. Includes independently released #405 catalog changes; main
parent d4b76910762b0d46f3cc416ba87fa0c985c283d3 passes Quality37677022593 and
standard37678605859. New AGENTS contract note read. Independent backend readback
passes on this parent under referral-deletion-parent-release. Private merge guard
expects this exact parent/candidate/run and fresh schema/advisors/mobile idle.
Only run after all5 candidate jobs pass. Standard main CI/release/readback remain.
Prepared strict verifier/changed signatures/8 function bodies+ACLs/Auth trigger,
complete migration plan, and 8-check rollback probe under referral-deletion-release.
Probe passes locally with zero cleanup.14 actual lifecycle,61 existing deletion,
18 notification recovery,45 focused,2328 SQL assertions/clean replay and types/lint
pass. Independent cleanup has zero users/programs/transactions/pending jobs.
User receipt diff hash remains bb579a5c0a2ee1540000d57c7e7580feeb4c0cb0ff1e9427f2c9bf41025007fc.

12B #403 is independently verified in production as 98f55011c8e820ae6e11acdb9d5f4dfb609b496e.
Candidate37659876117/main37661798356 all5 pass; standard37663113075 succeeds.
Independent 19:55:24 UTC readback, schema/function/ACL/runtime checks, expected
110+1 INFO advisor delta, five rollback checks and zero cleanup all pass. See
backend-section-12-referral-notification-release-2026-10-08.md.

Current branch codex/backend-referral-account-deletion-12c starts at this merge.
12C reproduces actual Auth deletion failures for both settled referral parties
(append-only ledger cascade); three unsettled/no-referral controls pass. Candidate
migration20261007174934 retains nullable live identities plus immutable detached
UUIDs, cancels deleted-recipient outbox work, disables codes, preserves buyer
purchase evidence and reconciles surviving rewards after refund/restore. Local
61 existing deletion cases,18 notification recovery cases and2328 SQL assertions
pass. Expanded candidate tests caught and corrected stale remaining_credits and
missing unsettled recovery after buyer deletion. Final reruns/clean replay,
release preparation/CI/PR/gates remain. No production DDL for12C has run.
Private generator build-referral-deletion-migration.py generates the migration
from captured baseline definitions; do not rerun against changed definitions.
Preserve all user receipt/Section1/private evidence edits.

Earlier checkpoints below are superseded by the verified release above.

#403 current candidate is e381ca8d502aa5b060b8668a1725929c57186cb3, Quality
37659876117. Initial 1ddddc66 passes 7,499 web tests and four other jobs but lint
rejects require() in the CJS test worker; corrected dynamic import passes local
lint and all18 actual cases. Intermediate0ad9c7c2 run37659606745 was cancelled
by normal concurrency after merging the independently released #404 top-bar fix.
New parent/live main89504467850df7e7f37b4552bf12e0ce2ad2d210 passes exact-main
Quality37652119339 and standard37653758032. Fresh independent five commerce
runtime/schema/all110 advisor/smoke checks pass on this parent; #404 changes
only AppShell/CSS/browser tests/design/AGENTS. Its new AGENTS CSS guidance was
read. The private referral merge guard now expects this exact parent/candidate
and run37659876117. Wait for all5 candidate jobs, then run fresh guard; do not
merge on the stale 1ddddc66/0ad9c7c2 checks. Schema/migration/runtime remain the
same as the prepared release verifier. A bounded exact-ID production ROLLBACK
probe is prepared and tested locally (five checks, independent zero cleanup);
run only after the deployed definitions verifier passes.


#403 is attached at https://github.com/112kratoss/ugc-copy/pull/403 on candidate
1ddddc668a05ec5b8ec8fd6679fd22e90dc32f3b, branch
codex/backend-referral-notification-recovery-12b. Initial exact-head Quality 37644567466 passes mobile/browser/migration/API jobs
and all web tests, but web lint rejects the new CJS worker require import. It is
corrected to a dynamic import and the 18-case suite is rerun before a new head. Independent local fixture cleanup is zero for users,
transactions, programs, outbox, jobs and injected triggers. Release preparation
is under .audit-evidence/backend-social/referral-notification-release/: fresh
production baseline, complete migration plan (only the new migration), exact
new-object signatures/three function definitions and ACLs from clean replay,
four runtime hashes, strict verifier and merge guard. The guard expects verified
#402 parent aea29967, Quality 37640696352 and standard 37642306396 attempt 2.
Run it only after exact candidate CI succeeds. The verifier requires unchanged
old schema, exact new object signatures/functions/ACLs and only one new INFO
rls_enabled_no_policy finding for the private outbox; do not accept other drift.
Release documents for #401/#402 and RevenueCat/admin browser readbacks are
committed in #403. This new checkpoint can be carried in the next audit PR.


12A #402 is independently verified at 15:25:36 UTC on
aea299676ff0f17a5b5c93eff8bbeef03caac0eb. All five exact-main jobs in 37640696352
pass. Standard 37642306396 attempt 1 ended after successful authorization with
no deploy job/failed-step diagnostic; first rerun API returned HTTP 500. The later
unchanged rerun succeeded as attempt 2. Independent five-runtime/schema/all110
advisor and live smoke checks pass. MAP-02 returns to untested; ledger counts
53: 24 passed, 25 untested, two failed (PAY-04/MEDIA-07), two external.
See backend-section-12-commerce-inputs-release-2026-10-07.md.

12B now reproduces two actual SQL/PostgREST lost-referral-notification cases.
Local candidate queues future financial events transactionally, delivers history
and push work atomically, and preserves retryability after settlement. All 18
actual cases include two SIGKILL checkpoints, managed partial failure, reversal/
restoration, poison backoff, concurrent drains, and real local HTTP push delivery.
151 focused cases and 2,316 SQL assertions pass; clean isolated replay, app/test
types and lint pass. Full local web suite: 7,495 passed/two stale-test failures; updated cron error mock
and SQL deep-link inventory with 11 focused repair cases passing. Candidate CI
must rerun the full suite. New migration
20261007150522_referral_reward_notification_outbox.sql is the only pending
production migration and sorts after the complete applied ledger. Production
referral ledger/reward/purchase-event counts are zero. No historical backfill or
production DDL. Review backend-section-12-referral-notification-recovery-2026-10-07.md.
Current checkout branch has uncommitted candidate and release/evidence docs;
retain user receipt edits and private/untracked Section 1 files. Candidate CI,
PR, fresh verified-parent/mobile-idle gates, main CI, standard release and exact
SQL/schema/advisor/runtime readback remain mandatory.

RevenueCat read-only inspection matches all eight current production receipt
rows to provider purchases with exact store ID/owner/product bindings. All are
sandbox and owned; source transactions successful/applied. Both app credential
flags, six credit products, default packages and production-only webhook are
configured. Three customer event lists are empty, which is not delivery proof.
See backend-section-12-revenuecat-readback-2026-10-07.md; PAY-05 stays external.


#401 is independently verified at 14:54:13 UTC on 0dbef436. Exact-main Quality
37588261608 and standard release 37589599345 pass; all six runtime digests,
schema/all 110 advisors, input/auth boundaries and smoke pass. The original
credit-order verifier incorrectly assumed proxy rejection for an absent bearer;
source-confirmed validation-before-Auth returns private 400, while unsigned
valid-plan and invalid-bearer controls both return private 401. Both verifier
versions and the correction are retained. See
backend-section-11-credit-inputs-release-2026-10-07.md and the actual local
admin-credit browser report; fixture cleanup is zero. Historical reconciliation
remains open and no customer balance was changed.

#402 candidate 9c60e9e255b37bc240e1199ec3a5e4dd00cd0c2b passes all five jobs in
37588642236. Fresh #401 verification/schema/advisor/live/main and immediate
mobile-store-idle gates pass. It merged at 14:54:46 UTC as
aea299676ff0f17a5b5c93eff8bbeef03caac0eb. Exact-main Quality, automatic standard
release and commerce-inputs-release/ independent readback remain. Its credit
verify null response is expected to be private 400 (required fields precede
signature/Auth), other unsigned commerce cases remain 401.

RevenueCat MCP read-only discovery now works for the Magicbooklet project.
Both store credential flags and all six credit products/default packages are
configured. The single webhook targets the expected URL, all event/app types,
production environment only. Configuration is not provider-delivery proof;
PAY-05 remains external. No provider configuration was changed.

Earlier checkpoints follow; the newer release status above supersedes them.

12A reproduces eleven actual exception/500 cases across marketplace/resource
orders and three payment-verification handlers, plus a resource null-root lookup
ordering case. Object guards/SyntaxError handling now preserve private 400s.
All 97 actual Auth/session/PostgREST/SQL cases and 91 focused cases, app/test
types, scoped lint and diff pass; independent order/transaction/intent/fixture
counts are zero. No provider or production balance mutation. Read
backend-section-12-commerce-inputs-2026-10-07.md. MAP-02 remains failed until
this and the combined input release are independently verified.

#398 is independently verified live as ff3a70be at 07:34:16 UTC. Exact-main
Quality 37583034551 and standard release 37583940527 pass, schema/all 110
advisors unchanged, smoke 200/307/401. See
backend-section-11-showcase-worker-death-release-2026-10-07.md.
#401 combined 11X/Y/Z head ae248eb8105d5a55460ec6be753e4531d07a8dcc passes
all five jobs in Quality 37583632596. Fresh independently verified #398/schema/
advisors/live/main and immediate mobile-store idle gates pass. It merged at
07:35:23 UTC as 0dbef436224bafae647f8a40979daad8a4d5bb90. Exact-main Quality
37588261608 is running; standard release and credit-inputs-combined-release/
independent readback remain. #399/#400 are closed as superseded, their changes
included in #401. No customer historical adjustment was repaired.

Release organization: 11X/11Y/11Z are combined into the final
codex/backend-credit-order-inputs-11z candidate, based on the verified #398
main release. #399/#400 are intermediate review heads; their changes are
included unchanged except the documented 11Y balance correction and additional
11Z controls. They will be superseded by the final combined PR, not independently
merged/deployed. The final combined head must pass all five Quality jobs; fresh
verified #398 schema/advisors/live/main and immediate mobile-store idle gates
remain mandatory. Exact-main Quality, standard staged production workflow and
independent six-runtime-source/schema/live readback remain mandatory. This
changes release grouping only; no test, migration, health or admission gate is
removed. No financial/customer repair or external/provider evidence is implied.

11Z reproduces six null/malformed/empty credit-order failures on the verified
/api/razorpay/order native handler, with real bearer headers and unsigned controls.
The adapter now validates an object root before existing missing-plan validation.
All 56 actual cases, 33 focused order/provider controls, app/test types, scoped
lint and diff pass; independent purchase-intent/transaction and owned fixture
counts are zero. No provider order/charge or production balance change.
See backend-section-11-credit-order-inputs-2026-10-07.md. Own candidate/main CI,
standard release and independently verified #398 parent remain required for the combined final candidate.
MAP-02 includes this finding as well as 11X until verified release.

#397 is independently verified live as 26888e15 at 06:41:18 UTC. All five
exact-main jobs in 37581266892 and standard release 37582438992 pass. One tested
runtime digest, schema/all 110 advisors, six private unsigned admin boundaries
and smoke pass. See backend-section-11-showcase-revocation-release-2026-10-07.md.
MEDIA-09 returns to untested for broader recovery. Counts are now 53:
24 passed, 24 untested, three failed, two external: MAP-02, PAY-04, MEDIA-07.
#398 fresh independently verified #397/schema/advisors/live/main and immediate
mobile-store idle gates pass; it merged at 06:42:47 UTC as
ff3a70beebea323b95da6bfc9969fcea12972ba1. Exact-main Quality 37583034551 is
running; standard release and independent revocation-worker-death-release/
readback remain. #399/400 must each wait for their verified parent.
#400 is attached on aeed54bfc59d21d9d7fc54a89591eb6163180a51; Quality
37582629485 is running. Its tested runtime digests/release verifier are prepared.
No historical customer grant or repair has been made.

11Y reproduces three actual SQL balance failures and four focused policy/RPC
failures. Goodwill/clawback now change total and promotional credits equally;
purchased restoration changes total only. Server and admin confirmation share
the pure policy. All 42 actual cases, 50 focused/component controls, app/test
types, scoped lint and diff pass. Own fixture rows are zero; no provider or
production balance mutation. See backend-section-11-admin-credit-balances-2026-10-07.md.
The production aggregate contains one historical positive promotional-only row
among three adjustments; intent/attribution/reconciliation remains operator
review, not an automatic repair. PAY-04 is failed until prevention release;
broader financial lifecycle stays open. Counts are 53: 24 passed, 23 untested,
four failed, two external. Initial concurrent-test syntax and component type
issues are preserved and corrected before publication.

#399 is attached on 8f5011e9e439f0afe898cdeed277d8f6ecfde663. Exact-head
Quality 37581746707 is running; independently verified #398 parent and standard
release remain required. It fixes 11X inputs with 37 actual/37 focused controls.

11X reproduces four native-handler null-root failures with real GoTrue tokens,
authoritative admin sessions and SQL. Two adapter modules now validate object
roots before reading fields. All 37 actual local cases and 37 focused controls,
app/test types, scoped lint and diff pass. Invalid bodies leave balances/state/
grants untouched; valid state/events and credit replay/reviewer binding work,
fixture balances return to 500/0, and independent exact-ID row cleanup is zero.
No migration/mobile runtime change. See
backend-section-11-auth-credit-inputs-2026-10-07.md. Own exact-head CI/release and
independently verified #398 parent remain required. MAP-02 is failed for this
new input finding until release; broader method/entrypoint coverage remains open.
Counts are 53: 24 passed, 24 untested, three failed, two external.

#396 is independently verified live as 0df4d065 at 06:22:31 UTC. Exact-main
Quality 37579524146 and standard release 37580473841 pass, schema/all 110
advisors are unchanged, and smoke is 200/307/401. Automatic duplicate
37580101875 skips. See backend-section-11-moderation-storage-release-2026-10-07.md.
#397 final candidate e4ff29a4 passes all five exact-head jobs in 37579912190.
Fresh verified #396 parent/schema/advisors/live/main and immediate mobile-store
idle gates pass. It merged at 06:23:46 UTC as
26888e1578350e5d2e06fa37d7189584a7457b1e. Exact-main Quality 37581266892 is
running; standard release and independent source/schema/live readback remain.
#398 final candidate 24801435 passes all five jobs in 37580073922 and is now
based on main. Hold its merge for independently verified #397 release.

Previous checkpoints follow; pending statements below are historical where
superseded by this checkpoint.

#398 is attached. Its child now incorporates corrected #397 parent e4ff29a4
and the exact merged #396 history. The final child needs new exact-head Quality;
initial 952b6aff/37579021921 is historical and does not gate the final candidate.
#397 initial 5d46e7eb/37578516790 failed one fixture due-time case as recorded
below; its corrected e4ff29a4 head needs complete fresh CI. Hold each merge for
its independently verified parent and own complete gates.

11W adds three actual Node worker SIGKILL checkpoints before Storage removal,
after actual removal and after gallery deletion commits. Each has the expected
durable queue/gallery/object state, completes in a fresh process, and has no
work on another fresh retry. All three cases, test types and scoped lint pass;
exact-ID object/row cleanup is zero and balances/usage remain unchanged. This is
the direct business processor, not managed lease/fencing or hosted CDN evidence.
No runtime/migration change. See
backend-section-11-showcase-revocation-worker-death-2026-10-07.md. Own final-head
CI and independently verified #397 parent remain required.

#395 is independently verified live as ebd551b6 at 06:02:45 UTC: exact-main
Quality 37577951136 and standard release 37578624582 pass, three tested runtime
digests match, schema/all 110 advisors are unchanged, all six unsigned mutation
boundaries are private 401 and smoke is 200/307/401. Automatic duplicate
37578732709 skips. Fetching the exact Git commit resolved an initial source
verification prerequisite; no runtime/production change for that issue. See
backend-section-11-admin-moderation-inputs-release-2026-10-07.md. SOCIAL-03
returns to untested; counts are now 53: 24 passed, 25 untested, two failed, two
external. MEDIA-07/MEDIA-09 remain failed.

#396 final-head Quality 37577628732 passes all five jobs on 024ea1a1. Fresh
verified #395 parent/schema/advisors/live/main and immediate mobile-store idle
gates pass. It merged at 06:04:12 UTC as 0df4d065600994e84b8eec7437aa0fd56cd31c6f.
Exact-main Quality 37579524146 is running; standard release and independent
moderation-storage-release/ verification remain. #397 must wait for that parent.

#397 initial Quality 37578516790 passed four jobs; the API job passed nine of
ten cases and caught the invalid-prefix fixture's database/app clock due-time
assumption. Its own queue rows are now explicitly due in the past. All ten
local cases pass with constraints intact and no application change for this
fixture issue. The candidate includes the exact merged #396 parent and must
pass new exact-head CI before release. #398 is attached with three actual
SIGKILL controls; its child branch must incorporate this corrected parent.

11V reproduces four actual SQL/Storage failures: normal cleanup omits display
media; failed/no-op Storage removal or reply loss after gallery deletion loses
retry paths and later reports success with fetchable objects. The shared helper
now retains gallery inventory until the full owned object set is verified absent.
All ten actual cases, 93 focused helper/publish/edit/worker controls and sixteen
direct moderation Storage cases pass. Types/lint/diff and exact-ID fixture
cleanup pass. Bounded production inventory reports zero current queued and known
private generation legacy rows; it cannot reconstruct previously lost references.
No customer repair or schema change. MEDIA-09 is failed until release; broader
renewed-reference races, fencing and orphan reconciliation stay open. See
backend-section-11-showcase-revocation-recovery-2026-10-07.md. Own exact-head CI,
independently verified #396 parent and standard release remain required.

PR #395 passed all five exact-head jobs in 37576758590. Fresh verified #394
parent/schema/advisors/live/main and immediate mobile-store idle gates passed.
It merged at 05:45:59 UTC as ebd551b6fe8c84c05e9811b52f6c211a4ac99d52.
Exact-main Quality 37577951136 and standard release 37578624582 pass;
independent readback is verified as recorded above. SOCIAL-03 is untested.
PR #396 is attached and retargeted to main. Final cleanup head
024ea1a16d8d98e3ac668bb1a44a891b92eaf7e2 is running Quality 37577628732;
initial head 5dd7db24 is historical. It must wait for #395's independent release.

PR #395 is attached: aad77b006aa57dc6017719ab37fe9b2b172f6724, Quality
37576758590 passed. That candidate became the merged #395 noted above.
11U is a separate child branch based on that exact candidate.
Sixteen actual session/PostgREST/SQL/Storage controls pass for both take-down
paths, all public/private gallery references, signed URL deletion, repeated
decisions, four transport fault boundaries, foreign paths, generation ownership,
external-reference disclosure and provisional hide/restore escalation. Test
types/scoped lint pass; exact-ID object/row cleanup is zero. An initial teaser
timestamp fixture error is corrected with the constraint preserved. No new
runtime defect or migration change; hosted cache/CDN behavior stays open.
See backend-section-11-moderation-storage-2026-10-07.md. The new suite is added
sequentially to Quality. Its own CI/release and independently verified #395
parent remain required before merging.

11T reproduces six null-body failures across post/subject report decisions,
post/generation moderation, contact triage and user sanctions. Three adapter
modules now admit only object bodies before reading fields. All 60 actual
GoTrue/session/PostgREST/SQL cases and 33 focused controls pass, including valid
actions, replay, reviewer binding, stored-session rejection and independent zero
fixture cleanup. App/test types, scoped lint and diff pass. Initial expiry,
self-report and revocation-clock fixture mistakes are preserved and corrected
without weakening constraints. Five routine definitions match production
exactly; the sixth differs only by four empty UUID-array casts, with reviewed
same-engine type/value/assignment controls. All six signatures/grants match.
See backend-section-11-admin-moderation-inputs-2026-10-07.md. Exact-head CI,
verified parent, standard release and independent readback remain required.
SOCIAL-03 returned to untested after this verified release; WORKFLOW-04
also returned to untested after #393. With the 11V finding, counts are 53:
24 passed, 25 untested, two failed, two external. MEDIA-07 and MEDIA-09 are
the failed rows. The wider audit is not signed off.

PR #394 exact-head Quality 37575031613 passes all five jobs on
c68443bc9a864d5a3f1db8bd2d5c3fcdf71f0826. Fresh verified #393 parent, schema,
advisors, live/main and immediate mobile-store idle gates pass. It merged at
05:25:22 UTC as aaedf1eb8ff8692501ea836cf3076b5d43968ca3. Exact-main Quality
37576225908 and standard release 37577267512 pass. Independent readback at
05:42:23 UTC confirms exact live/project, unchanged schema/all 110 advisors and
200/307/401 smoke. See backend-section-11-template-publication-release-2026-10-07.md. The admin candidate is based on this merged parent
and must wait for its independent live verification before merging.

PR #392 passed all five exact-head Quality jobs in 37571640504 on
1f4b97a311711f06f690e7bcaee364f53c6dfab1. Fresh parent metadata/live/main and
immediate mobile-store idle gates passed. It merged at 04:41:42 UTC as
0daff46610c558a921e860f5e69be6427abb1a81. Exact-main Quality 37572688415 and
standard release 37573683409 pass. Independent readback at 04:58:14 UTC confirms
the exact live/project, unchanged public schema/all 110 advisors and smoke
200/307/401. See backend-section-11-map-recovery-release-2026-10-07.md and private
map-recovery-release/. This parent release is verified.

PR #393 is attached and automatically retargeted to main after #392 merged.
Initial head 107e2e69afc8c8f573846c4e368ef145ae539cc7 passes all five jobs in
Quality 37572636133.
Final head af4f6941c2d971f4295f8a5fea7155f40b682234 includes the exact merged
parent and 11R controls. All five exact-head Quality jobs pass in 37573889158.
Fresh schema/advisors, verified parent/live/main and immediate mobile-store idle
gates pass. #393 merged at 05:07:28 UTC as
547b6658acaac7e9234efb1ce3ee2826da3304ec. Exact-main Quality 37574773814 and
standard release 37575379640 pass. Independent readback at 05:21:27 UTC confirms
exact live/project, unchanged schema/all 110 advisors, both tested runtime
digests, private authoring boundaries and 200/307/401 smoke. See
backend-section-11-workflow-inputs-release-2026-10-07.md. WORKFLOW-04 returns to
untested for the broader matrix.

The preceding template-publication branch included the exact merged #393 parent
and preserved user receipt edits/private evidence. Its final candidate became
PR #394 after #393's independent release verification.

11S adds sixteen actual GoTrue/PostgREST/Storage publication controls with no
runtime or migration change: owner/foreign/unsigned authoring, exact publication
preconditions, immutable activation, real signed demo bytes, correctly shaped
client RPC permission denial, three committed-reply faults, actual SQL constraint
rejection/copy cleanup, missing/foreign sources, bounded two-publisher barrier and
disable visibility. All sixteen cases pass; final rejecting-barrier case also
passes. Types/lint/diff and independent exact-ID/namespace cleanup pass. Two
production routine definitions/role grants match read-only. Real generation
provenance, video/fixed-asset variants and hosted execution stay open.

OPS-03 reconciliation confirms no active current-build capacity certificate;
the August exact-build certificate is historical. The runbook's obsolete next-
release compatibility removal instruction is reconciled to explicit DB-05
installed-client review. Both workflow starters currently retain authenticated/
service grants with prior verified admission controls. No grant removal, cloud
provisioning, production load or new capacity claim is performed.

11R adds nine actual local blueprint billing cases: duplicate response replay,
owner-scoped keys, concurrent pending hold, exact bucket refund and new-key retry,
invalid provider replies, committed settlement reply loss, insufficient credits
and mismatched keys. All pass; authoring+billing totals 25 actual API cases,
with zero independent fixture/rate cleanup. Both ledger routine definitions/
roles match current production metadata read-only. No additional runtime fix or
provider request. Broader conservation, pre-submission death/stale pending holds
and true provider delivery remain open.

11Q adds nine actual local Auth/PostgREST reproductions: canvas PATCH null throws,
other invalid/unreadable roots return 200, and wrong-type/malformed blueprint
inputs return 500. Candidate validation returns private/no-store 400 before
authoring or billing work. All 16 actual API cases and 38 focused cases pass;
app/test types, lint and diff checks pass. Every fixture balance stays 500, usage
is empty and independent cleanup is zero. Native handlers are invoked directly;
no hosted Next/browser/provider execution is claimed. New API suite is added
sequentially to Quality. This candidate must use a separate stacked PR/head;
hold its merge until #392 is independently verified live.

Current ledger is now 53: 24 passed, 25 untested, two failed, two external.
WORKFLOW-04 and SOCIAL-03 returned to untested after their verified scoped
input fixes; their remaining matrices stay open. MEDIA-07
remains failed. 11T adds only the three input parser modules; no schema/customer
changes are introduced.

Recovery/protocol evidence #391 is independently verified live as
3f04cb16f9435d8a20735a2ac7ca7514db9ddb3a at October 7 04:24:57 UTC.
Exact-head Quality 37567181374, exact-main Quality 37567982126 and standard
release 37568927963 pass all jobs. It merged at 03:42:15 UTC, and the standard
release completed 03:57:45 UTC. Exact live/project, unchanged schema/all 110
advisors and 200/307/401 smoke pass. See the 11M/N release report. No runtime
or migration change; actual managed backup recovery remains open.

11O refreshes production/source mapping on that same build at 04:25:24 UTC:
162 routes, 201 services, 337 functions, 138 relations, 12 jobs and zero
unassigned routes. All 14 added functions/two added tables have existing test
and release links; the 14 function definitions/role grants match clean replay.
153 secondary entries classify as 86 catalog-bound, nine source/operator,
34 inspected SQL and the same 24 retained compatibility entries. Earlier
snapshots are preserved; no grant/function removal or behavioral closure.

11P adds three real owned worker SIGKILL/restart cases after queue claim,
provider-task attachment and step linking, with exactly one accepted image/hold,
duplicate settlement, downstream approval/video refund and independent zero
fixture cleanup. The full 21-case canvas DB suite, test types, lint and diff
checks pass locally. The first harness assertion used a nonexistent DTO field;
the corrected stored-settlement assertion passes without a runtime fix. The
next exact-head CI/release gates remain; broader WORKFLOW-02/03 stay untested.

Wallet #385 is independently verified live October 6 20:34:11 UTC as
c3995ddc8e5ca1b29fb7a777e62300e844043900. Refreshed candidate 476b2463 passes
Quality 37523837244; exact-main Quality 37525598535 and standard release
37526868504 pass. Only the new function/grant changes the schema; existing
functions/ACLs and all 110 advisors are unchanged. Signed/zero-wallet rollback
controls pass with zero Auth/profile/wallet fixtures; smoke is 200/307/401.
Digest cd2b014a27e6b7276f75a26805730069 matches replay. Source 20261006193446
maps to production 20261006203018 by independent readback without ledger repair.
See the 11G release report. Other actor's #384 mobile/AGENTS changes are preserved.

User-error #386 is independently verified live October 6 20:51:29 UTC as
1be9dabafab48d159303250f48fd21ee58932cd4. Final head c608f035 passes all five
Quality jobs in 37525678057; exact-main Quality 37527510112 and standard release
37529011506 pass. Public schema/110 advisors are unchanged, all three runtime
file digests match the production Next/browser candidate, twenty live
unauthenticated HTML/RSC admin boundaries pass, both diagnostic timestamps
return private/no-store 400, and smoke is 200/307/401. The actual signed retry
proof remains the isolated production build with empty cleanup; no live positive
support record or fresh signed production session is claimed. See the 11H release.

Combined health/signup #388 is independently verified live as
f227c69577503d35f04ddfc9dd000d932d10735e after standard release 37532928397
attempt 2 passed at October 7 02:43:55 UTC. Exact-head Quality 37529823695 and
exact-main Quality 37531415452 pass all five jobs. Attempt 1 failed its final
protected health build-id check after promotion; preserve that log and do not
claim a cause. The unchanged failed-job retry passed protected health.

Fresh independent verification at 02:47:11 UTC confirms the planned Auth trigger
only, unchanged ACLs/all other functions and all 110 advisors, matching digest
38b2a5ff84299035c88e229345f9cefa, passing collision/welcome rollback controls and
zero fixtures. Separate readback maps source 20261006203443 to production
20261006211856 without repair. At 02:47:26 UTC the live health source matches the
48-case actual API candidate. Smoke is 200/307/401. See the 11I/J release report.
#387 is CLOSED as consolidated, with no separate main release.

SQL/evidence-only operator #389 passed all five exact-head Quality jobs in
37531592475 at 7af0c783246da6c83eac3cc2bc6b6fc45cb3d16e. Fresh parent/main/live
and immediate mobile-store idle gates passed. It merged October 7 02:47:43 UTC
as a171fd76c0dadfef8ce307a62b9188c2c475f055. Exact-main Quality 37563686429 and
standard release 37564295252 pass. Independent verification at 03:00:52 UTC
confirms exact live/project, unchanged schema/all 110 advisors and smoke
200/307/401. See the 11K release report.

11K adds 22 actual clone and 35 mobile catalog operator assertions (57 total),
with actual client-role denial, service calls, copy/activation/retry/conflict
controls, zero local fixtures and read-only production definition/role parity.
It changes no runtime, migration or live catalog.

11L adds 40 actual SQL assertions and three actual connection-lock races for
bind_legacy_mobile_store_transaction_product. All pass, the full replay suite
passes 2,304 assertions in 106 files, and independent fixture cleanup is zero.
Four production/local operator/trigger definitions and grants agree read-only.
No defect or runtime/migration/catalog/provider change. See the 11L report;
PR #390 final head 4e0ea817e648e7bfef8007041e9def56690d5ce5 passes all five
Quality jobs in 37564312876. Verified parent/live/main and mobile-store idle
gates passed; it merged at 03:08:25 UTC as 2ee4066b3d763714d379e43ad2945e67e6c47f77.
Exact-main Quality 37565354138 and standard release 37566336430 pass all jobs.
The release completes at 03:24:44 UTC; independent verification at 03:25:27 UTC
confirms exact live/project, unchanged schema/all 110 advisors, smoke200/307/401.
See the 11L release report. No release work remains pending for #390.
Broader DB-03/MAP-02/GEN-05/PAY scope stays open.

11M local logical backup/restore and credit reconciliation pass at 03:12:39 UTC.
The target had no network/published ports. All 167 table row digests, 175 relation
owners/ACLs, 356 routine owners/ACLs, 15 roles/23 memberships match. All 940 public
constraints match semantically; ten nested-AND CHECKs normalize on restore,
verified by engine reparse, so raw constraints fingerprint differs. Fifteen
other schema-class hashes match. Duplicate/other-owner/missing post-backup credit
controls pass, balances 500 then reconciled 1,000, and client reads deny.
All source table digests return to baseline; the whole owned target is retired.
Archive/scripts/failed attempts remain private in backup-restore/. Production
read-only metadata shows seven completed physical backups/PITR disabled.
11N adds twenty read-only deployed protocol/admission controls, all passing on
both a171 and the released 2ee build. GET/HEAD/preflight, native compatibility,
CORS origin headers and unauthenticated profile/admin boundaries pass. This is
server-response evidence, not positive client/browser/provider delivery.

No actual production backup or Storage recovery is verified; OPS-02 remains
untested. Local/live column-order/extensions/functions differ. See the 11M report;
no runtime, migration, provider request or customer operation changes.

Current ledger: 53 obligations — 24 passed, 26 untested, 1 failed, 2 external.
AUTH-01 returns to passed after verified 11J; OPS-04 returns to untested after
all known reproduced defects are released, with the broader matrix still open.
MEDIA-07 legacy environment retirement remains failed. No full audit signoff.

GitHub marked #383 merged into its candidate base branch at 19:23:11 UTC when
its commits were incorporated into #382. It has no separate main merge or
production release. Preserve that attached evidence. Obsolete #383 CI cancellation
was requested; only #382's final exact head gates the collector main merge.

11F reproduces active catalog disappearance after eleven newer shadow releases.
The candidate queries active status separately from the bounded history. All
21 actual API/SQL controls across the six collector modules and 50 focused
cases pass; types/lint and exact fixture cleanup pass. Production's active
revision has 38 entries/no newer releases, so no current incident is attributed.
The initially invalid starting-generation fixture was corrected to SQL-supported
waiting; no generation lifecycle constraint or runtime was changed.

11D/E/F are consolidated into #382 to use one collector release after #381.
The final combined head must pass all five Quality jobs, including 107 actual
API cases. Preserve separate before/after reports. #383's tested code is included
in #382 and its PR is superseded; it must not merge independently. Runtime
migration/function verification remains required for 20261006190707. Wallet
limits and partial collector failures remain audit work; no full signoff.

11E reproduces 1,001-order revenue counted as 1,000 without a truncation warning,
and a newest failed job missed after 1,000 successes, through actual PostgREST.
The candidate pages revenue within the existing 2,000-row rail budget with exact
counts and aggregates daily jobs in a service-role-only SQL RPC. All 14 actual
API/SQL cases, 25 focused cases, types/lint pass. A clean replay passes 2,174
assertions in 101 pgTAP files, including eleven new summary controls. Specific
fixture cleanup is empty. Read-only production has 939 runs/12 names/zero
failures, so no current missed failure is attributed. The source migration is
20261006190707; standard release/function/privilege checks remain. This is now consolidated into #382 and held until #381 is verified.

## Earlier checkpoints (historical; current status is above)

Operations #381 passed fresh exact-head Quality 37515495937 on 5354a3b6 and
merged with mobile-store idle at October 6 19:12:29 UTC as
235aca0165500b53d436aef4eb4e54fffb489616. Exact-main Quality 37517212787 is running; standard release and independent checks remain. AUTH-02 remains failed
until verified live. #382 is open with its new API CI job running on f0a319f2;
all 93 actual Linux API cases pass. Initial workflow run 37516028671 was rejected
before jobs for unavailable runner.temp in job env; the path now resolves in a
runner step. Final candidate must incorporate the parent main revision and
pass its own exact-head CI; retarget #382 to main, then hold for parent release.

11D reproduces mobile credit ledger mirrors counted as Razorpay orders in the
admin overview. Two real PostgREST/SQL regressions fail before the filter and
all seven cases pass after it; 16 existing focused cases, app/test types and
scoped lint pass. Specific transaction/Auth/profile cleanup is empty. Read-only
production counts are zero for recent web purchases and mobile mirrors; no
current production miscount is established. The candidate adds an isolated
Quality API job to run 61 deletion, 25 operations and seven collector cases
sequentially against a clean Auth/Storage/PostgREST stack. Pinned Linux CLI and
exact-head CI must certify that job before merge. PR #382 is stacked on operations #381; hold merge until the parent is independently verified.

11B/C operations PR #381 now includes both timestamp validation and independent
admin-page gates. Exact candidate d51850c0 failed full CI 37513911652 only in
three old missing-user render fixtures calling the newly gated page outside a
request. All three reproduce locally; an authorized identity fixture fixes them
without changing runtime or denied-page controls. Head 5354a3b619043c111257812eb42b68c8b487608f
passed fresh Quality 37515495937; all 58 focused cases, types and scoped lint pass.
All 20 revoked HTML/RSC and ten active page checks pass on the actual production
candidate; Playwright verifies the activity redirect contains no private marker.
Cleanup is empty and server/browser stopped. AUTH-02 remains failed until this
fix is released; prior Apple/Chrome evidence is preserved.

FX #380 is independently verified live as eac420e23b42e804f0307c5c0285b770eacae17b
at October 6 19:01:32 UTC. Exact-main Quality 37513081761 and standard release
37514320846 pass; public schema and 110 security findings unchanged, smoke
200/307/401, all six live FX rates positive/finite. Vercel exposes cache-control
public without s-maxage; do not infer effective edge TTL from that header.
See the 11A release record. Another actor's preceding #378 mobile change is
preserved. The verified parent gate for #381 is now satisfied; require its fresh
exact-head CI and an immediate mobile-store idle check before merge.

Retention #379 is independently verified live at October 6 18:39:29 UTC; Quality
37510132894/release 37511731539 pass. The release record covers unchanged schema,
110 unchanged advisors and 200/307/401 smoke. MEDIA-09 returns to untested for
broader recovery. 10F #377 is independently verified at 18:12:33 UTC on ab9eb3ad,
with planned trigger only, all 23 rollback controls, zero fixtures and unchanged
advisors; PAY-04 remains untested for its broader lifecycle matrix.

Current ledger: 53 obligations — 24 passed, 25 untested, 2 failed, 2 external.
Failed OPS-04/MEDIA-07; AUTH-02 is verified as passed above. OPS-04 also includes the 11D reporting defect and
broader collector/method behavior. Six admin collectors belong to OPS-GATE;
the seventh page-only service, home dashboard, belongs to SOCIAL-GATE. These
bounded releases do not close the full audit. Preserve receipt text/evidence.

10I adds eight actual signed-refund failure/retry controls: pre-commit RPC 503
and post-commit acknowledgement loss across live/deleted/Storage-failed/Auth-
failed creator states. Real telemetry insertion is tracked by returned fixture
IDs; cleanup removes only those IDs. All eight targeted cases and all 61 actual
local deletion/access cases pass (168.69 seconds); types/lint pass. No runtime
or schema change. Preserve in a separate evidence commit after parent 10H.

10H reproduces a missing committed retained Storage copy being trusted on retry,
then source Storage/Auth being erased. Four actual regressions cover missing
copy repair, both copies missing, metadata outage and invalid retained mapping.
Candidate validates the deterministic mapping and actual Storage object before
skipping copy; only actual not-found permits re-copy, other failures halt erasure.
Local Storage info reports HTTP 400 plus statusCode 404 for a missing object;
classify using statusCode first. Missing source remains safely failed (do not
bypass blocked-owner writes to pretend recovery). All 53 actual deletion/access cases pass on Node 24.21.0 (163.35 seconds),
plus 36 focused service checks, app/test types and scoped lint; tracked cleanup
passes. No schema change. 10G signed-webhook evidence is included in the next
scoped runtime fix PR. MEDIA-09 is failed until release verification; ledger is
24 passed, 24 untested, 3 failed, 2 external (53 obligations).

10E #376 is independently verified live on b82a7de9 at October 6 17:56:54 UTC:
exact-main Quality 37505298701, standard release 37506928664, planned function
only, all 23 rollback controls, zero fixtures and 110 unchanged advisors pass.
See detached cash release report. Prod ledger version 20261006175317 maps to
source 20261006172011. 10F #377 passed exact-head Quality 37505858506 and merged
with mobile-store idle October 6 17:57:20 UTC as
ab9eb3ad0ce90e5053e782d9b87231d7a48b57de; exact-main Quality 37507548395
is running. Standard release/independent partial-deletion-refund-release/ checks
remain. Do not merge the next candidate before parent verification.


10G adds twelve actual local signed webhook controls: refund/dispute/won across
live/deleted/Storage-failed/Auth-failed creators; real HMAC/tampered bytes,
dispatcher/SQL, idempotency, entitlement revocation, manual review, retrying
cleanup and buyer retained-file reads. All twelve targeted controls and the
expanded 49-case actual suite pass; types/lint pass. No runtime/schema change.
See signed-cash-webhooks report; no genuine provider called. Preserve evidence
in a separate batch after parent #377 is released/verified.

10F PR #377 is open on 34abafbe9cb506ff817111d6fff9402741bfa891;
exact-head Quality 37505858506 passes all four jobs. Parent 10E exact-main
Quality 37505298701 passed; standard release 37506928664 is running. Independent
10E detached-refund-release/ verification must pass before merging #377.
Follow-up partial-deletion-refund-release/ baseline is captured after 10E's
migration, with exactly one ordered 10F migration pending. Verify mobile-store
idle immediately before merge.


10F reproduces Storage/Auth-failed deletion freezing legitimate cash refunds
(SQLSTATE 55000). Two actual PostgREST failures pass after the strict sales-count
exception candidate; all 37 actual deletion/access cases pass (160.92 seconds).
Only a positive sales count decreasing by exactly one, with all other fields
except updated_at identical, bypasses the freeze. Zero/no-op, content, price,
publication, paths, increments and new captures remain blocked. The initial
broader rule failed an unchanged freeze regression and was tightened. Clean
replay passes 2,163 assertions in 100 files (38 new). Production rollback
baseline is 13/23 passing; separate cleanup finds zero fixtures. See 10F report.
New migration: 20261006173448_allow_refund_sale_count_during_deletion.sql.
No customer repair or genuine payment/provider request.

10E PR #376 passed exact-head Quality 37504089324 on
f75a0c1642f5ac82fb613dde41dd72f75897a71b and merged with mobile-store idle
October 6 17:39:55 UTC as b82a7de987ad08212edc12b134be02e2a3d8be6c.
Exact-main CI, standard release and independent detached-refund-release/ checks
remain. The saved local function evidence is valid (10F changes only its guard).
Its verifier re-derives cleanup IDs from each rollback run's actual fixture
output. Do not merge 10F before the parent is independently verified live.

10E fixes detached refund rejection and refund/erasure deadlock, includes 10D
retained-access evidence, and passed 35 actual local deletion/access cases
(final authoritative quote/capture snapshot: 154.77 seconds), five real SQL
concurrency cases, and clean 2,125 assertions. Baseline rollback was 7/23
passing, no fixtures remain. Three detached paid orders were observed, no
customer repair performed. PAY-04 remains failed while 10E/10F verification is
pending; ledger remains 24 passed, 25 untested, 2 failed, 2 external (53).

10C #375 is independently verified live on
ba6d3ff2c3148dda6d16a9afd29e920ec1f8fde0 at October 6 17:36:42 UTC.
Exact-main Quality 37502728609 and standard release 37504283695 passed;
unchanged schema/all 110 advisors and feed/admin/webhook boundaries pass.
See purchased-reference release report. 10B #374 is independently verified
live at October 6 17:19:25 UTC on 383c6503; reports/evidence remain preserved.

10C adds five actual local purchased legacy-generation-input controls. A remix
revision's supplemental reference and attachment survive creator deletion in
neutral Storage; actual buyer signed reads match the source bytes. Four 503
listing/read/write failures halt deletion and recover from durable failed jobs.
All 27 actual deletion cases pass (147.56 seconds), including live expiry/grace;
test types/lint and fixture cleanup pass. No runtime/schema change; no provider
called. See 10C report. Main #374 is incorporated with the exact tested file
preserved. Open the scoped evidence PR; merge only after the parent release
is independently verified.

9O/10A #373 is independently verified live on
b9729ee41f4fc4db1c500bc96283d667eae34847. Exact-main Quality 37498165169 and
standard release 37499514443 passed; unchanged schema/110 security findings and
feed/admin/webhook checks pass at October 6 17:00:44 UTC. See 10A release record.
All 19 model and 27 current deletion controls also pass on Node 24.21.0. Local
fs-ext was rebuilt from its old Node 22 ABI; use Node 24 for subsequent tests.

10B #374 passed exact-head Quality 37498287785 on de100f06 and merged with
mobile-store idle October 6 17:01:20 UTC as
383c65038daac34ebd7a3f9100846a18b96a6687. Exact-main Quality 37500291828 is
running; standard release and independent account-deletion-identities-release/
verification remain. 10C incorporates this main with its tested files preserved. Do not merge 10C before the parent release is independently verified.

10B adds ten actual local deletion controls: linked guest order/partial Auth
failure; all eight owner buckets; template snapshot anonymization/public/private
post namespaces; poisoned cross-creator generation reference preservation;
Storage enumeration/fingerprint failure recovery and changed-email claim replay.
A live child pauses after copy commit and resumes after both real 30-second lease
expiry and the unchanged two-minute grace; the new worker completes, the buyer's
file stays readable and the old worker performs no Auth deletion. All 22 actual
cases, test types and lint pass. Fixture cleanup passes; no runtime/schema change.
See 10B report. AUTH-03 broader scope remains open. 10B is in PR #374; main #373 is incorporated, preserving the exact tested files.

9O/10A and 9N release evidence are in PR #373, exact head
31a979fd3d7dc2c69203e96ea4a1a94e6665a9b8, Quality 37496465208 passed.
It merged with mobile-store release idle October 6 16:45:05 UTC as
b9729ee41f4fc4db1c500bc96283d667eae34847. Exact-main Quality 37498165169 is
running; standard release and independent unchanged-schema/live verification remain. The original model-history fix is already independently verified.

10A adds twelve actual local Auth/Storage/PostgREST/SQL deletion controls:
owner-only files/Auth, capability block and delayed resweep, Storage/Auth
failure recovery, anonymous/confirmation/reauth/caller boundaries, purchased
file retention/read, copy/mapping failures and real SIGKILL at copy/Auth commits.
All pass, plus test types/lint. Fixture rows/objects/retained files and upload
blocks/rate keys removed. No runtime/schema change. Route adapter is in-process;
no Apple/payment provider contacted. AUTH-03 remains untested for its broader
scope. See account-deletion report. Preserve the separate 9O evidence.

9N #372 is independently verified live on
9cbe5815aa94179e90b1c249cd932a4f369b38b4. Exact-head Quality 37362149076,
exact-main Quality 37494657028 and standard release 37495795918 passed.
Seven rollback controls, planned function/grant only, zero fixtures and 110
unchanged security findings pass; feed/admin/webhook checks pass. See the
9M/9N release report. 9M #371 is included as an ancestor; its own release
37362937477 failed before a hosted runner acquired the deployment job.
No deployment action occurred in that failed run.

9O adds five actual managed model-verification controls: durable failed/retried
history reads, overlap, abandoned expiry and SIGKILL after provider response or
committed snapshot. All 19 actual cases, test types and scoped lint pass. Original
catalog restored; fixtures/job rows removed; no fixture locks. No new runtime or
schema change. See model-verification-recovery report. Preserve separately from
9N PR #372, head 93d7b0a3, exact-head Quality 37362149076 passed; #372 is released and independently verified.

9N implements per-model latest verification history after an actual sparse-history
regression: 101 observations for one model hide another model's seven-failure
history in the old shared window. New service-only invoker lookup retains it and
breaks equal timestamps by identity. Fourteen actual local HTTP/PostgREST cases,
15 new pgTAP controls, app/test types and lint pass. Clean replay and 2,102 SQL
assertions across 98 files pass; no public schema drift. Seven bounded rollback
controls pass locally; model-verification-release/ has the production baseline,
one-migration plan and verifier. PR #372 passed CI and release verification; see 9N report. Runtime
change is only the lookup; no provider contacted. Preserve local edits.

9M #371 passed exact-head Quality 37353739378 on 9cc05bcf and merged with
mobile-store idle October 5 19:09:32 UTC as c0f33e438800de69b6e99736ac2904141d0a93e1.
Exact-main Quality 37361374584 passed; standard release failed before a hosted
runner acquired the job. Independently verified on the released 9N descendant. Seventeen actual feed-maintenance recovery controls pass;
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

Current ledger 24 passed / 26 untested / 1 failed / 2 external (53). JOB-02 returns
to untested after the provider-history fix is verified; MEDIA-07 failed for legacy retirement. Full goal active.
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
