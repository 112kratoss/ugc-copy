# Backend section 01: authentication and account access

Date: 2026-09-26. Initial audit status: **read-only review finished; findings and validation gaps remained open.** See the remediation update below. No later section was started in this pass.

Reviewed source and production-reported build: `e0f28361a3d2cf28dea860189fc9aa0227e655a1`. Production `/api/app-version` returned that build ID. Supabase project: `ildfmhozpibwiopeavfg`. The database snapshot was read at 05:42 UTC. Matching the reported application build does not certify every database object against migrations.

Evidence: [production schema and HTTP results](backend-section-01-auth-2026-09-26-evidence.json). This contains schema metadata and response statuses, with no user records or credentials.

## Scope and method

Reviewed central bearer-token admission, the route policy registry, signed internal admission assertions, the regional feed exception, guest/registered identity helpers, profile access, admin login/session boundaries, the OAuth callback, and account merge/deletion authorization. Financial settlement and asynchronous cleanup internals require their own sections.

Production work consisted of catalog/definition SELECT queries, security advisor inspection, six unauthenticated or deliberately invalid GET probes, and one GET to read the deployed build. There were no production data/configuration changes, account creations, login attempts, token revocations, merge/deletion calls, deployments, or load tests. Normal request/access logging may record the probes.

Local tests ran with a restricted environment and no supplied production credentials: **28 test files, 219 tests passed**. These are unit, mocked integration, and source-contract tests; they are not a live identity matrix. No application source was changed.

## Findings

### AUTH-01 — Medium: guests can bypass the creator-profile registration gate

`src/lib/profile-route-adapter-service.ts:159` rejects guest profile changes with 403, explicitly to prevent anonymous username squatting. Production nevertheless grants `authenticated` column-level UPDATE on ten profile fields, including `username`, `display_name`, and `bio`.

The effective UPDATE policy checks only `auth.uid() = id`, plus a restrictive `current_identity_is_active()` check. No policy or inspected profile trigger requires registration. Supabase anonymous sign-in users also use the `authenticated` database role; they are distinct from unauthenticated requests using the `anon` role. [Supabase anonymous sign-ins documentation](https://supabase.com/docs/guides/auth/auth-anonymous).

An active guest with their own valid token can therefore bypass the Next.js profile endpoint and update their own creator fields through the Data API. The production unique index on `lower(username)` makes username reservation a concrete impact. This does not establish a welcome-credit bypass: that RPC separately rejects guests.

Evidence: live column privileges, all three profile policies, profile trigger definitions, and the username unique index. Source grant: `supabase/migrations/20260620040420_restrict_profile_credit_updates.sql:5`. **Confirmed at the schema/authorization level; no production UPDATE was attempted.**

Remediation: enforce registered-only profile mutation in the database. Preserve guest reads and service-role lifecycle operations. Choose between a restrictive registered-only UPDATE policy and revoking direct column UPDATE after checking supported clients. Add real database tests for guest denied, registered owner allowed, another user denied, and protected columns denied.

### AUTH-02 — Medium: session revocation and ban checks differ between API and Data API

Production `current_identity_admission()` checks `auth.users.deleted_at`, `banned_until`, and the caller's `session_id` against `auth.sessions`. The API rejects a banned account or missing session. By contrast, the production `current_identity_is_active()` function used by profile RLS checks only `profiles.identity_state = 'active'`.

A revoked session can leave an otherwise unexpired access token, and revocation alone does not mark the profile as merged or deleting. The profile policy therefore lacks the session check enforced by the API. Likewise, an Auth ban alone does not appear in that RLS predicate. Supabase documents that revoked access tokens remain valid until expiry unless the application adds an authoritative session check. [Supabase sign-out documentation](https://supabase.com/docs/guides/auth/signout).

Impact is continued access within existing row/column permissions during the token's remaining lifetime, including own-profile reads and permitted updates. This is not arbitrary cross-account access. No `pgrst.db_pre_request` setting was found in database/role settings; externally configured gateway behavior was not independently verified.

Evidence: live definitions in the JSON snapshot and `supabase/migrations/20260819073000_identity_and_linked_deletion_hardening.sql:164`. **Confirmed policy mismatch; an end-to-end replay using a revoked production test session is pending.**

Remediation: define one required revocation/ban behavior across API, Data API, Storage, and Realtime. If immediate denial is required, put the necessary checks into database authorization and cover relevant RPCs as well. Measure the cost before changing the shared RLS helper. Add a controlled revoked/banned-session regression test before closing this issue.

### Carryover — High: guest merge still clamps negative balances

The earlier financial finding remains visible in the production `merge_guest_account` definition: both the guest amount moved and target balance use `greatest(..., 0)`. A negative target balance can consequently be cleared when a merge settles. Source: `supabase/migrations/20260811110000_merge_guest_account_into_registered.sql:303`.

The merge authorization boundary is stronger than this accounting invariant: guest preparation requires an active guest; redemption requires the registered caller; tickets are random 32-byte secrets stored only as SHA-256 hashes; and the redemption RPC is inaccessible to ordinary Data API roles. These checks do not repair the balance calculation. Keep the debt finding open for the credits/payments section; no production merge was exercised here.

## Coverage ledger

| Surface | Evidence obtained | Remaining validation |
| --- | --- | --- |
| Route identity inventory | All 160 API route files have policy entries: 33 guest, 78 registered, 20 public, 29 service. Exhaustiveness tests pass. | Inventory coverage does not prove each method's business authorization; check those in its section. |
| JWT/admission assertions | Source and tests cover invalid claims, signature errors, expiry, method/path/token binding, caller-header stripping, and unavailable dependencies. | Live valid-token and key-rotation/fallback scenarios. |
| API lifecycle checks | Live admission function checks account existence, soft deletion, bans, and present session IDs. Tests cover merged/deleting/revoked/banned states. | Controlled guest, registered, revoked, banned, deleting, and merged production sessions. |
| Regional feed admission | Source wrapper and 13 tests checked; malformed bearer returned 401 in production. | Valid-session and revoked-session requests through this path. |
| Profile isolation | Live owner policies; protected balance/identity columns have no client UPDATE privilege. | AUTH-01 and AUTH-02; real two-user and guest database tests. |
| Admin authentication | Source gates on all eight admin action routes; HMAC, credential-version rotation, authoritative session rows, revocation, and outage behavior tested. | Authenticated live login/logout/replay and deployed secret/configuration validation. GET proxy rejection alone is not proof of POST enforcement. |
| Sensitive auth tables/RPCs | Admin sessions, merge tickets/history, and deletion jobs have RLS and no anon/authenticated table DML grants. Merge, ticket redemption, and deletion preparation RPCs deny those roles. | Dedicated regression fixtures; no real records were accessed. |
| Account merge authorization | Caller-derived target, guest-only preparation, hashed tickets, expiry/conflict/retry logic reviewed; mocked tests pass. | Concurrent redemption and lifecycle races against real database fixtures; financial carryover remains open. |
| Account deletion authorization | Registered identity, explicit DELETE confirmation, fresh authoritative Auth lookup, recent sign-in/Apple identity checks, and fail-closed behavior reviewed/tested. | Destructive flow and recovery with designated disposable accounts; provider behavior and cleanup effects are not live-certified. |
| OAuth callback/onboarding | Code exchange followed by verified user lookup; safe next-path handling and onboarding tests pass. Production E2E bypass is prohibited in source and tests. | Live signup, OAuth, email confirmation, password recovery/change, refresh/logout, and mobile deep-link flows. |
| Hosted Auth configuration | Local password-policy baseline test passes; security advisors inspected. | Hosted password policy, redirect allowlist, CAPTCHA/rates, token lifetimes, and provider configuration were not fetched: no Management API token was available in the process environment. Local config is not proof of hosted settings. |

The admission function intentionally accepts a signed token without a `session_id` for legacy compatibility; a source database test explicitly expects this. This was not reported as a proven exploit. Closing session validation should include a decision about whether sessionless tokens are still required.

## Verification results

All six production probes returned **401** with `Cache-Control: private, no-store`:

1. GET `/api/profile` without a token.
2. GET `/api/profile` with a malformed bearer token.
3. GET `/api/profile` with a fabricated internal admission header and no token.
4. GET `/api/generations` without a token.
5. GET `/api/admin/users/credits` without an admin cookie.
6. GET `/api/showcase/feed` with a malformed bearer token.

The 219 local tests ran in two batches:

- 18 files / 160 tests: account-identity, route-identity-admission, route-identity-policy, identity-admission-assertion, regional-identity-admission, server-helpers-authentication, admin-auth, admin-authoritative-session, account-merge-service, account-deletion-route-adapter-service, apple-account-deletion-service, account-deletion-service, account-deletion-resource-retention, supabase-auth-cookie, supabase-auth-config, auth-callback-route, profile-route-adapter-service, profile-route-service.
- 10 files / 59 tests: admin-proxy-gate, admin-session-route, admin-session-migration, auth-onboarding, auth-onboarding-server, e2e-auth, profile-route, identity-deletion-hardening-migration, account-deletion-integrity-migration, account-deletion-sold-post-guard-migration.

All files are under `src/__tests__` with `.test.ts` suffixes. The database fixture suite `supabase/tests/database/current_identity_admission.test.sql` was reviewed but not executed against production because it inserts users/sessions and changes identity state. A transaction rollback would not make that a read-only production test.

## Section closure and next sections

To sign off this section: resolve AUTH-01; resolve or explicitly accept AUTH-02's token-lifetime behavior; verify hosted Auth settings; run the missing identity/provider scenarios using designated disposable accounts; and retain the merge accounting issue in the credits section. Recheck the exact deployed build and live schema after fixes. Passing the current unit suite is insufficient to close these gaps.

Continue one section at a time, each with its own inventory, evidence, findings, and closure status:

1. Authentication and account access — this report; open findings/gaps.
2. Database authorization and ownership — tables, views, RPCs, grants, constraints, Storage and Realtime policies.
3. Credits, purchases, refunds, and referrals — accounting and reconciliation invariants.
4. Generation and provider integrations — admission, ownership, callbacks, retries, and costs.
5. Workflows and templates — graph/run authorization, transitions, retries, and idempotency.
6. Media and storage — signing, upload finalization, privacy, retention, and delivery.
7. Posts, feeds, profiles, and community — publication, visibility, moderation, and interactions.
8. Marketplace, resource bundles, and payouts — entitlements, settlement, and access revocation.
9. Jobs, cron, webhooks, and operational controls — authentication, replay, leases, retries, and alerting.
10. Deployment, recovery, and capacity — migration/deployment consistency, restoration, external configuration, and separately scoped performance tests.

These are section boundaries, not a claim that unlisted behavior is covered. Expand each inventory from routes, service entry points, database objects, jobs, and external integrations before testing it.

## Remediation update — 2026-09-26

The user authorized fixes, verification, and production deployment. Migration
`20260926135311_harden_identity_access_and_merge_balances.sql` addresses the
three confirmed issues:

- AUTH-01: a restrictive registered-only UPDATE policy protects creator fields while retaining guest profile reads and owner isolation.
- AUTH-02: the shared RLS predicate now uses the same account/session/ban admission as the API. Storage inherits the existing shared policy. Both remaining authenticated workflow definer mutations also check admission before any write. This governs database policy evaluations; it does not claim to disconnect an already-open Realtime connection immediately.
- Merge debt: guest and target signed credit/promotional balances are conserved. The merge ledger accepts signed transfers and retains idempotency, ownership, and service-only invocation. Historical balances are not automatically reconstructed; any repair requires a separate ledger reconciliation.

Existing sessionless signed-token compatibility is preserved consistently with
`current_identity_admission()`. New normal Supabase sessions carry a session ID;
this release does not tighten that separate legacy-token contract.

Verification before release:

- The new real-database regressions failed before the fix (14/22 identity assertions and 14/35 merge assertions), then all 57 passed after it.
- Clean migration replay succeeded, followed by all 73 pgTAP files / 1,356 assertions.
- Web suite: 811 files passed; one UI test timed out under concurrent local load. Its entire 23-test file passed in isolation. The total suite contains 5,977 tests. CI remains the release gate.
- App, script, and test typechecks passed; lint has zero errors and two pre-existing unused-variable warnings.

Production verification is repeatable with
`scripts/ops/verify-identity-boundaries.mjs --confirm --project-ref <ref> --base-url <https-origin>`
under an environment containing the matching Supabase URL, client key, and service
key. It creates one guest and one confirmed disposable registered account (no
signup email), tests owner isolation and guest/banned/revoked/merged/deleting
access via real JWTs, tests a zero-credit merge and retry, and removes only its
own fixture IDs in guest-first order. It performs no paid generation or purchase.
Recovery IDs are kept in a private temporary file if cleanup fails. Never use
`scripts/ops/guest-checkout-acceptance.sh` for production verification: it is a
local-only fixture reset script.

Release must go through exact-main-SHA Quality and Production release workflows.
The broader provider/OAuth/password recovery and hosted Auth configuration
checks in the coverage ledger are separate remaining audit coverage; fixing
these findings does not certify those unexercised flows.
