# Section 6B — retry incomplete provider success results

Base: `65890e3146309b5e62fac155f72983de4475a7a1`. Date: 2026-09-30.
Status: reproduced and fixed locally; CI/release pending.

## Finding

The generation reconciliation worker treated a provider success flag with no
usable output URL as successful settlement. The generation and completion job
became terminal with `output_url = NULL` and no refund. A later valid callback
was acknowledged but skipped because task attachment saw an already-settled
generation. The user had neither their output nor a retryable generation.

Video and motion status polling had the same empty-output settlement path.
Image polling and malformed result parsing could instead return `succeeded`
without output while the database remained active, telling clients to stop
polling prematurely.

## Reproduction and fix

An actual local Next.js `/api/webhooks/kie` HTTP request used valid v2 HMAC
headers, the real route/after worker, and a local HTTP bridge to the isolated
PostgreSQL database. An empty market success payload produced terminal success
with no output; a second valid callback produced no import ticket. The fixture
initially sampled before `after()` completed; it was corrected to await a
completed attempt, and the baseline was rerun before implementation. No real
provider request or production mutation occurred.

Six real-DB worker/polling regressions and seven status-service regressions failed
before the fix, covering both market and Veo response shapes, missing URLs and
malformed JSON. The worker now polls fresh provider state when callback output
is incomplete. A still-incomplete poll throws a retryable reconciliation error
instead of settling success. Existing retry limits and refund policy remain in
place. Image/video/motion polling returns a processing response with consistent
timing and a retry interval, preserving the mobile API's existing response shape.
Shared contract variants and mobile client tests pin that behavior.

The signed HTTP probe after the fix retained the first completion attempt as
pending, then accepted the later complete callback and durably queued its media
import. A deliberately disallowed media URL then exercised import retry: the
generation remained processing, credits were unchanged and the import returned
to pending with one attempt. The probe waited for that worker before removing
fixtures. No external media was downloaded.

## Additional recovery verification

The database integration suite also checks that:

- Exhausted incomplete results use the existing single-refund policy.
- A failure uploading the second item in an output list defers settlement;
  retry uploads the full list and settles only when all outputs persist.
- Losing the success-settlement response after its database mutation schedules
  recovery; the next worker observes the succeeded generation and closes the
  import without another upload or charge.

Media staging/storage and preview work are fixture boundaries in those last
checks; queue, generation, settlement and credit effects use actual PostgreSQL
functions inside rolled-back transactions. They do not certify real storage
outages, provider deliveries or serverless process death.

## Production inventory and scope

A read-only aggregate found 88 succeeded generations and one with missing output.
That row already carries a source-unavailable timestamp from September 8 and
predates this audit. This is not evidence attributing it to the reproduced bug;
no historical state or customer balances were changed. No active processing or
waiting rows were present at inventory time.

No migration or mobile binary/OTA release is required. The change is backend
behavior plus test/contract coverage. Real provider delivery remains unverified.
Private evidence and HTTP fixtures: `.audit-evidence/backend-section-06b/`.
Section 6A's preceding local contention probes remain in their separate report.

## Local validation

- 148 focused web/database checks passed across eight files; ten use real local
  queue/settlement SQL and are now a required step in the database CI job.
- 116 mobile API contract checks passed, including three output-pending variants.
- App, web-test and mobile TypeScript checks passed; changed web files passed ESLint.
- Mobile dependencies were initially absent from this checkout, causing local
  config/type errors. An isolated `npm ci` in `ugc-mobile` restored them; the
  checks above then passed. The primary checkout and lockfile were unchanged.
