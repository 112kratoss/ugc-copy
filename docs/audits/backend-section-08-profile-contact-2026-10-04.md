# Section 8E — profile payloads and contact behavior

Date: 2026-10-04. Existing audit checkout; no production data mutation.

Malformed JSON and the JSON value `null` returned HTTP 500 from both
`PATCH /api/profile` and `POST /api/profile/validate`. The parser exception or
null property access reached the generic server-error handler. Actual Next HTTP
against the isolated local Auth/PostgREST stack reproduced all four failures;
eight identity/success controls passed. Both adapters now reject malformed or
non-object payloads with HTTP 400 and `Invalid profile payload.` before domain
validation or mutation. Authentication and private no-store responses are retained.

## Verification

- Actual local Next HTTP: 12/12 pass after the fix, covering both malformed/null
  cases, valid payloads, unauthenticated and guest denial, profile GET and session
  revocation. Disposable Auth identities and rate-limit rows were removed and
  absence checked. The dev server was stopped after verification.
- Permanent adapter regressions: ten failures before the fix; after-fix coverage
  includes malformed JSON, null, arrays, strings and numbers on both routes.
  Mocks returning success explain the baseline primitive outcomes; the actual
  HTTP reproduction establishes the malformed/null defect independently.
- Seven actual PostgREST controls: caller-bound profile mutation ignores injected
  identity/balance fields; duplicate usernames reject without overwriting another
  profile; synchronized competing username writes yield one success/one 409;
  invalid fields do not partially persist; contacts normalize fields; malformed
  and oversized contact fields reject; ten messages persist, the eleventh is
  rejected before body parsing by the database-backed rate limit.
- The initial profile fixture used an invalid underscore in its username and
  failed three cases with 400. Correcting the fixture to a permitted hyphen makes
  all seven pass without a domain-service change. This was not a product defect.
- 67 focused web tests in nine files and 123 mobile contract tests pass. App and
  test typechecks and scoped ESLint pass. Shared contract records the 400 response;
  mobile client tests preserve its status, message and details.

PostgREST controls are opt-in via `vitest.profile-contact-postgrest.config.ts`,
`AUDIT_STORAGE_CONFIG` and `SUPABASE_TEST_DB_URL`; both URLs must be loopback.
They run against the existing isolated stack, not production. Normal CI runs the
adapter/contract regressions; it skips tests requiring that local API configuration.
Private before/after logs and HTTP scripts: `.audit-evidence/backend-social/`.

## Scope and release

No SQL migration, mobile runtime change, external provider request or historical
repair is required. CI and standard production release remain pending. This
bounded fix leaves SOCIAL-04 open: creator privacy/visibility, profile media,
request byte limits and other lifecycle/abuse behavior still need evidence.
