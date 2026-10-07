# Section 11J — Auth profile placeholder collisions

Distinct valid Auth UUIDs sharing their first eight hex digits receive the same
`creator-<8 hex>` username. The case-insensitive unique index then aborts signup.
Production and both owned local databases have the same original trigger digest,
`04f6383c64d898c4f466f81f9ca83a67`; this is a code-level reproduction, not a claim
that a particular production signup failed.

Actual local GoTrue admin creation reproduces two colliding identities, another
UUID already owning the preferred placeholder, and eight concurrent signups
sharing a prefix. The real Auth insert trigger also rejects an anonymous
collision. Noncolliding registered and public anonymous signup are controls.
The final baseline has four failing collision cases and two passing controls.

Migration `20261006203443_auth_profile_username_collision.sql` retains the first
preferred name and uses the existing unique index to arbitrate each insert.
Only a username conflict retries, with a random eight-hex placeholder and a
32-attempt bound. Unrelated constraints still fail. Existing profiles and
balances are not repaired or rewritten. The definer search path is fixed and
execution stays service-only.

The fallback keeps the exact generated-name format used by web/mobile onboarding
and welcome eligibility. All six actual Auth/SQL cases pass, including all eight
concurrent creations, original-owner preservation, zero starting credits and
denied welcome eligibility for a registered fallback. Anonymous collision uses
a valid public anonymous Auth row copied without generated columns to force its
UUID at the SQL trigger, followed by a GoTrue admin read; public anonymous signup
itself chooses its own UUID and is separately exercised as a control.

Clean replay succeeds. All 2,207 SQL assertions in 103 files pass, including 22
new trigger, grant, zero-credit, welcome-barrier and uniqueness assertions.
The replayed trigger digest is `38b2a5ff84299035c88e229345f9cefa`, with unchanged
`{postgres=X/postgres,service_role=X/postgres}` privileges. App/test types and
scoped lint and 44 focused profile/onboarding/welcome/migration cases pass. The actual Auth suite is added sequentially to the existing
Quality API integration job.

Early fixture errors are preserved privately: uppercase names violate the
existing format check, incomplete raw Auth rows fail GoTrue reads, and generated
Auth columns cannot be copied. They were corrected without weakening constraints
or changing runtime beyond the reproduced trigger. Exact failed fixture IDs were
removed on the owned loopback database; the final suite independently checks
empty Auth/profile cleanup after every case.

The health sample source from #387 is consolidated into [PR #388](https://github.com/112kratoss/ugc-copy/pull/388) with this trigger fix. The independently verified #386 release is the parent; each finding keeps separate verification controls.

The [11I/J release](backend-section-11-auth-health-release-2026-10-07.md) passes
final exact-head/main CI, standard release after an unchanged failed-job retry,
and independent live function/rollback/cleanup checks. AUTH-01 returns to passed.
The 53-row checklist is 24 passed, 26 untested, 1 failed and 2 external. No new
obligation or full-audit signoff is claimed.
