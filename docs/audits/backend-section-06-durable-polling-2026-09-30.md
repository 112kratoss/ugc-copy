# Section 6C — durable imports from video and motion polling

Base: `3db9a9c7e5becec035fe131208ffeb8286e55101`. Date: 2026-09-30.
Status: reproduced and fixed locally; CI/release pending.

## Finding and reproduction

Video and motion status polling downloaded and uploaded provider output inline.
A download failure or Storage upload error instead settled success using the
temporary provider URL. No durable import ticket was created. A later import
worker skipped that terminal generation, leaving the original media vulnerable
to provider URL expiry. Preview repair writes derivatives, not the original.

Four isolated PostgreSQL reproductions cover video/motion download and upload
failures. A second probe adds a real import job after each premature settlement:
the job completes with zero uploads and leaves the temporary output unchanged.
Six permanent regressions then reproduce the failure across market video, Veo
and motion. The preceding ten recovery tests continued to pass on that baseline.
The bug is in status-service persistence and settlement, not callback delivery.

## Fix and validation

All three video/motion success paths now enqueue the existing durable output
import and return processing, no output, processing timing and a 15-second retry
interval. The shared worker owns download, upload, settlement and success
notification. Its existing notification dedupe key covers worker replay; a
regression verifies successful imports notify, and failed imports do not.
Failure notifications remain on the existing status path.

Six real-database cases exercise the status service through the response adapter,
then inject download/upload failure in the worker, repeat polling, retry the
import and check durable owner-prefixed output with unchanged credits. These
also assert no premature success notification. Duplicate polling retains job
identity and attempt count. Existing queue behavior brings a pending retry
forward on enqueue; this batch does not change that policy or claim preserved
backoff. The initial test assumed unchanged retry time; it was corrected after
reading the existing enqueue SQL, and that failed probe is retained privately.

Queue and settlement calls execute actual service-role PostgreSQL functions in
transactions rolled back after each case. Provider status, media staging,
Storage and notification delivery are test boundaries. The adapter's Response
is exercised in process; this is not a live HTTP/provider/Storage certification.
No production data or balances are changed and no provider charges are incurred.

Shared mobile contract fixtures add import-pending variants. Two mobile tests
verify clients retain the processing response. This does not change mobile
runtime code or require a binary/OTA. No database migration is required.

Local validation: 46 focused web/database checks across seven files (including
16 real-database recovery cases), 118 mobile contract checks, app/test/mobile
type checks and targeted ESLint. A mobile assertion initially accessed an
unknown timing type directly; it now uses a typed-safe object assertion.

Private evidence: `.audit-evidence/backend-section-06c/`. Supabase's changelog
and current Storage upload documentation were checked; no SDK/schema/API change
is introduced. Section 6B release evidence accompanies this batch. Historical
provider-hosted outputs are not repaired without an attributed inventory.
